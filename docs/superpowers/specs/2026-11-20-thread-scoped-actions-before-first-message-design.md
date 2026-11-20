# Thread-Scoped Actions Before the First Message — Design

Reported as: typing `#` in Workspace Chat does nothing — the Tool Menu never opens, with no error shown. Root cause, confirmed during debrief: Workspace Chat mints a `threadId` client-side and persists it onto the workspace the instant its tab mounts (`ui/src/pages/workspaces/workspace-chat-tab.tsx:152-158`), but the backend only creates the matching `threads` table row lazily, in `upsertThreadOnFirstMessage` (`api/src/services/thread-store.ts:318`), when the first real message is actually sent (`api/src/agents/workspace-chat-stream-handler.ts:185`). Any endpoint that looks the thread up via `ThreadStore.getThreadMeta(threadId)` 404s during that gap. The user independently hit the same 404 on "Orient to wiki" (`POST /api/v1/threads/:id/wiki-orientation`) on a fresh thread, confirming this is one root cause with multiple symptoms, not a Tool-Menu-specific bug.

The gap closes permanently the moment a thread's first message is sent — `upsertThreadOnFirstMessage` then creates the row for good. So the bug only reproduces in the window between "this thread id now exists and is being used by the UI" and "a message has actually been sent in it": a brand-new workspace, or the fresh successor thread right after Replace Thread (same lazy-creation path, see GLOSSARY.md's "Workspace Chat Continuity Across Threads").

## Scope

Confirmed broken, reachable from the composer before any message exists:

1. The `#` Tool Menu autocomplete (`ui/src/components/chat-input.tsx`'s `updateToolMenu` → `GET /api/v1/threads/:id/tools`).
2. "Orient to wiki" / "Clear wiki orientation" (`POST /api/v1/threads/:id/wiki-orientation[/clear]`) — the user's own observed 404.

Code-confirmed siblings, same underlying guard, same reachability:

3. The "Edit Tools" drawer (`chat-input.tsx:895`'s `openThreadToolsDrawer`) — same `/threads/:id/tools` endpoint as (1).
4. The Thread Report button (`thread-report-button.tsx` → `GET /api/v1/threads/:id/report`), rendered in the composer footer unconditionally.

This is deliberately **every chat surface that renders `ChatInput`** — plain/global chat (`ui/src/pages/chat/index.tsx`), workspace chat (`ui/src/pages/workspaces/workspace-chat-tab.tsx`), and wiki-ingestion chat (`ui/src/pages/wiki/ingestion-chat.tsx`) — not Workspace Chat alone. Main chat's `activeThreadId` and wiki chat's `wikiThreadId` (`ui/src/hooks/use-thread.ts:31-33`, `ui/src/pages/wiki/use-wiki-ingestion.ts:26-32`) are lazily-backed the same way Workspace Chat's is; they just lack an existing round-trip to the backend before the first message, so nobody has reported hitting this there in practice. The fix below closes the gap for all three without needing one.

**Explicitly not touched**: every other `/threads/:id/*` route (fork, rename, delete, archive/unarchive, retry, stop, generate-title) keeps its existing 404 on an unknown id. Those routes are meant to act on a thread the caller already believes exists — silently materializing one there would mask real bugs (a typo'd id, a stale reference) instead of fixing anything. Only the four handlers above, which a composer can legitimately reach before any message exists, change behavior.

## Mechanism: an idempotent "ensure" instead of "assume it exists"

**`api/src/services/thread-store.ts`**: two methods, instead of one, where today there's only `upsertThreadOnFirstMessage`:

- **`ensureThreadExists(threadId: string, type: ThreadType = 'chat'): void`** — new. The same `INSERT OR IGNORE INTO threads (id, title, created_at, updated_at, type) VALUES (?, ?, ?, ?, ?)` statement shape `upsertThreadOnFirstMessage` already uses, called as `.run(threadId, '', now, now, type)` — a real row, with an empty placeholder title. Called from the four handlers below, right where they currently 404. None of those four handlers read or branch on `thread.type` today (confirmed by inspection — `computeThreadTools`, `setWikiOrientationHandler`, `clearWikiOrientationHandler`, and `buildThreadReport`'s call site all key off message/tool data, not thread type), so a generic placeholder type is safe to stamp speculatively; it self-corrects below the moment a real message arrives.

- **`upsertThreadOnFirstMessage(threadId, titleSeed, type)`** — kept, same name and call sites (`stream-handler.ts:903`, `wiki-stream-handler.ts:64`, `workspace-chat-stream-handler.ts:185`), but its body changes from a plain `INSERT OR IGNORE` to an upsert that also corrects an already-existing-but-still-empty row:

  ```ts
  upsertThreadOnFirstMessage(threadId: string, titleSeed: string, type: ThreadType = 'chat'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO threads (id, title, created_at, updated_at, type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, type = excluded.type, updated_at = excluded.updated_at
         WHERE (SELECT COUNT(*) FROM thread_messages WHERE thread_id = threads.id) = 0`,
      )
      .run(threadId, titleSeed, now, now, type);
  }
  ```

  This is what makes a speculative `ensureThreadExists` placeholder (empty title, generic type) get silently corrected to the real title and real type the moment the thread's actual first message is sent — the `WHERE` clause means a thread that already has messages is left alone, exactly like today's `INSERT OR IGNORE` behavior for every thread that isn't in this edge case. No behavior change for the overwhelming common case (row didn't exist at all); the only new case is "row exists, zero messages, now correct it."

**Call sites that change from "404 if missing" to "ensure, then proceed"**, all in `api/src/routes/v1/threads.handlers.ts`:

- `getThreadToolsHandler` / `putThreadToolsHandler` / `deleteThreadToolsHandler` — replace `const thread = store.getThreadMeta(threadId); if (!thread) return notFound(...)` with `store.ensureThreadExists(threadId); const thread = store.getThreadMeta(threadId)!;`.
- `setWikiOrientationHandler` / `clearWikiOrientationHandler` — same replacement for their `if (!store.getThreadMeta(threadId)) return notFound(...)` guard (`threads.handlers.ts:210`, `:232`).
- `generateThreadReportHandler` (`:377`) — call `store.ensureThreadExists(threadId)` before `buildThreadReport(threadId, {...})`, so the external `@tkottke90/thread-reports` package (which this repo doesn't own and can't patch) always sees a real row. **Caveat, to verify during implementation**: that package's behavior for a thread with zero messages hasn't been inspected here (its source isn't available in this environment) — if it renders something degenerate rather than a clean "no activity yet" report, the handler may additionally need a cheap short-circuit before calling it (e.g. a new `store.getMessageCount(threadId)` — doesn't exist yet — checked for `=== 0`, returning a minimal empty-state response instead of calling the external renderer at all).

No frontend changes are required. Every one of the four affected requests is made from existing composer code exactly as it is today; they simply stop 404ing.

## Why this also fixes Replace Thread's successor, for free

Replace Thread (GLOSSARY.md, ADR-0064) mints a fresh successor `threadId` and repoints `workspace.threadId` to it with no checkpoint or row pre-created — explicitly "same as any new workspace-chat thread" per the comment at `api/src/routes/v1/workspace-chat.handlers.ts:70`. It goes through the identical lazy-creation gap, so it's covered by the same fix with no special-casing.

## Out of scope

- Extending eager/mount-time thread creation to main chat or wiki chat. Rejected during grilling in favor of the "ensure on first thread-scoped action" approach above, which covers all three surfaces without needing a new mount-time round trip anywhere, and without ever creating a persisted "ghost" thread row for a chat someone opens and never touches.
- Improving `chat-input.tsx`'s silent `.catch(() => { toolMenuOpen.value = false; })` (`:590-592`) into a user-visible error for a genuine failure (network error, 500, etc.). That catch stays as the fallback for real failures; this design only removes the one failure mode (404 on a not-yet-existing thread) that was wrongly routed through it. General error-visibility for the tool menu is a separate concern, not pursued here.
- A database migration. No schema change — both `ensureThreadExists` and the updated `upsertThreadOnFirstMessage` use the existing `threads` table as-is.

## Testing

Per the root `AGENTS.md`, all ship in the same PR:

- **Unit** — `thread-store.test.ts`: `ensureThreadExists` creates a row with an empty title and the given (or default) type when none exists, and is a true no-op (doesn't touch title/type/updated_at) when a row already exists; `upsertThreadOnFirstMessage` still behaves exactly as today when the row doesn't exist yet; when a row already exists **with zero messages** (the new case), it overwrites title/type/updated_at; when a row already exists **with messages**, it remains a no-op, matching today's behavior exactly.
- **Unit** — `threads.handlers.test.ts`: `getThreadToolsHandler`, `putThreadToolsHandler`, `deleteThreadToolsHandler`, `setWikiOrientationHandler`, `clearWikiOrientationHandler` each now succeed (don't 404) when called against an id that has never been seen before, instead of requiring a pre-seeded thread via `upsertThreadOnFirstMessage` as today's tests do; `generateThreadReportHandler` likewise succeeds (or returns the documented empty-state response, depending on what implementation finds necessary per the caveat above) rather than 404ing.
- **Orchestration**: confirm the other `/threads/:id/*` handlers (fork, rename, delete, archive/unarchive, retry, stop, generate-title) are unchanged and still 404 on an unknown id — a regression guard that this fix didn't accidentally widen beyond the four intended handlers.
- **E2E** (`@user-workflow`): create a brand-new workspace, open its Chat tab, and — before sending any message — successfully open the `#` Tool Menu, open the Edit Tools drawer, and use "Orient to wiki." Repeat the `#` Tool Menu check once more after using Replace Thread, against the fresh successor thread.
