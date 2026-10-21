# Thread Archiving & Sidebar Retention — Design

**Date:** 2026-10-20
**Status:** Proposed
**Related:** [GLOSSARY.md "Thread Archiving & Sidebar Visibility"](../../../GLOSSARY.md), [ADR-0027](../../adr/0027-sidebar-retention-filters-only-the-unfiltered-thread-fetch.md), [ADR-0028](../../adr/0028-archived-threads-reject-hitl-answers-too.md), [ADR-0029](../../adr/0029-archived-thread-view-is-not-threadview.md), [ADR-0030](../../adr/0030-sidebar-retention-default-seven-days.md), [Cron task triggers design](./2026-09-26-cron-task-triggers-design.md) (task-thread read-only precedent), [Agent wait design](./2026-09-27-agent-wait-design.md) (action-route precedent), [Thread model persistence design](./2026-09-21-thread-model-persistence-design.md)

---

## Goal

The global chat sidebar gets noisy quickly. Give the user two independent, composable ways to declutter it without ever deleting data:

1. **Archive** a thread by hand — it leaves the sidebar for good and becomes read-only, but stays fully recoverable.
2. A configurable **Sidebar Retention Window** — threads inactive long enough quietly stop showing in the sidebar on their own, with zero effect on the thread itself; continuing one brings it right back.

## Problem

The sidebar (`ui/src/components/thread-sidebar.tsx`) lists every `chat`-type thread, forever, sorted by `updated_at`. There is no way to get a thread out of that list short of `Delete`, which is destructive. The user wants noise reduction that is reversible (Archive) and automatic (age-based), without losing anything.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                      | Rationale                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Scope: `chat`-type threads only**, for both Archiving and the Sidebar Retention Window. `wiki`/`workspace-chat`/`task` threads are untouched.                                                               | The complaint is specifically about the global chat sidebar, which only ever lists `chat`-type threads.                                                             |
| D2  | An **Archived Thread** rejects chat, retry, fork, _and_ hitl-answer with 409; rename/delete/report/unarchive stay allowed.                                                                                    | See GLOSSARY.md and ADR-0028 — deliberately broader than the existing `task`-thread guard, which exempts hitl for an unrelated reason.                              |
| D3  | **Unarchive** lives only on the Threads page; **Archive** is reachable from both the Threads page and the sidebar's own `ThreadRow` dropdown.                                                                 | An Archived Thread never appears in the sidebar, so there's nowhere to put Unarchive there.                                                                         |
| D4  | The Threads page's existing single-purpose "Report" column becomes a general **Actions** column: the existing `ThreadReportButton` plus a new Archive/Unarchive toggle, shown only for `chat`-type rows (D1). | User-specified — repurpose rather than add a second column.                                                                                                         |
| D5  | The Threads page gains an **Archived** filter tab / status badge.                                                                                                                                             | It's the only place an Archived Thread is visible or manageable at all (D1/D3).                                                                                     |
| D6  | Archive/Unarchive are **dedicated `POST` action routes**, not folded into the existing title-only `PATCH /:id`.                                                                                               | Matches this codebase's existing state-transition-route pattern (wakeup cancel/trigger).                                                                            |
| D7  | Archiving a thread with a pending HITL prompt is **unconditionally allowed**, no confirmation dialog.                                                                                                         | Keep Archive a plain one-click action; the prompt simply waits for Unarchive.                                                                                       |
| D8  | Archiving the thread currently open in the sidebar **redirects to a new blank thread** — the same handling `deleteThread()` already gives the active thread.                                                  | Keeps `ThreadView` permanently unaware that Archiving exists (see D9/ADR-0029).                                                                                     |
| D9  | Opening an Archived Thread routes through a **new, small, self-contained read-only view**, never through `ThreadView`/`switchThread()`.                                                                       | ADR-0029 — avoids the same "becomes your persisted default thread" trap `task` threads already dodge via `TaskRunView`.                                             |
| D10 | **No live cross-tab sync** of archive state — enforcement is lazy, via the existing 409 → `stream_error` assistant-bubble path.                                                                               | Rare race, and free: no new broadcast event needed.                                                                                                                 |
| D11 | The Sidebar Retention Window is a **single global config value**, no per-thread override.                                                                                                                     | Matches this app's single-local-user config model.                                                                                                                  |
| D12 | Age is measured from **`updatedAt`**, not `createdAt`.                                                                                                                                                        | Consistent with how the list is already sorted; an active old thread never ages out.                                                                                |
| D13 | Retention/archive filtering applies **only to the sidebar's own type-less `GET /threads` fetch** — `?type=all` and any explicit `?type=X` are always unfiltered.                                              | ADR-0027 — the Threads page must always be a complete, trustworthy record.                                                                                          |
| D14 | `chat.sidebarRetentionDays` **defaults to `7`**, not disabled.                                                                                                                                                | ADR-0030 — a deliberate deviation from this app's usual opt-in-by-default config convention.                                                                        |
| D15 | A thread merely aged out of the sidebar carries **no extra state, badge, or restriction of any kind** — it is purely a sidebar-list exclusion.                                                                | User-specified: retention is a sidebar-only display concern; continuing the thread anywhere else is completely normal and brings it back on the next sidebar fetch. |

## Non-goals

- Archiving or retention filtering for `wiki`, `workspace-chat`, or `task` threads (D1).
- Any badge, flag, or special handling for an aged-out (not archived) thread — see D15; it is never distinguished from a normal thread anywhere outside the sidebar's own filter.
- Live/broadcast sync of archive state across open tabs (D10).
- A per-thread retention override (D11).
- A confirmation step on Archive (D7).
- Blocking Archive on a thread with an in-flight turn, or aborting that turn — this codebase's existing per-thread turn serialization (`pending-thread-turns.ts`) already prevents a concurrent second turn on the same thread; Archiving just means the _next_ attempt after the current turn settles gets the 409.

---

## Design

### 1. Data model (`api/src/services/thread-store.ts`)

- New migration adding a nullable `archived_at TEXT` column to `threads` (check the file's version-number ledger comment for the next free version at implementation time — 34 is the highest claimed as of this writing, but other stores sharing the database claim numbers too).
- `RawThreadRow` / `ThreadSummary` / `mapThreadRow` gain `archivedAt: string | null`.
- New methods `archiveThread(id): ThreadSummary | null` and `unarchiveThread(id): ThreadSummary | null`, following `markThreadToolsCustomized`'s existing precedent of _not_ bumping `updated_at` for a non-conversational state change.
- `listThreads` signature extends to `listThreads(filter?: { type: ThreadType; excludeArchived?: boolean; updatedAfter?: string })`. `excludeArchived`/`updatedAfter` are only ever passed by the one call site covered by D13.

### 2. Config (`api/src/config/env.ts`)

- `ChatSchema` gains `sidebarRetentionDays: z.number().int().min(0).default(7)` (D14/ADR-0030). `0` disables retention filtering entirely (D11's "global on/off").
- No new settings slug: `settings.handlers.ts`'s existing `agent-behavior` slug already round-trips the whole `chat` section (`chat: ChatSchema.partial().optional()`), so the new field falls out for free on the API side. Only the Settings UI panel needs a new form field: "Hide inactive threads from sidebar after (days) — 0 to disable."

### 3. API

`api/src/routes/v1/threads.route.ts`:

- The type-less branch of `GET /` computes a cutoff from `env.chat.sidebarRetentionDays` (skipped entirely when `0`) and calls `listThreadsHandler(store, { type: 'chat', excludeArchived: true, updatedAfter: cutoff })`.
- New `POST /:id/archive` and `POST /:id/unarchive`, mirroring the wakeup cancel/trigger route shape. Each 404s if the thread doesn't exist and 400s if it isn't `type: 'chat'` (D1 — rejected outright, not silently ignored).

`api/src/routes/v1/threads.handlers.ts`:

- `archiveThreadHandler` / `unarchiveThreadHandler`, same `HandlerResult<ThreadSummary>` shape as the existing `renameThreadHandler`.
- `forkThreadHandler`'s existing `if (source.type === 'task') return conflict(...)` gets a sibling: `if (source.archivedAt) return conflict('Archived threads are read-only')`.

`api/src/routes/v1/chat.route.ts`:

- `rejectIfTaskRunThread` is generalized (or a sibling check added alongside it) so the chat-send and retry routes also 409 on an Archived Thread.
- The `/hitl` route gains a new guard it doesn't have today (D2/ADR-0028) — it currently has no `task`-style check at all, only `respondIfTaskPrompt`'s unrelated re-queue short-circuit.

### 4. UI

`ui/src/hooks/use-thread.ts`:

- `ThreadSummary` gains `archivedAt: string | null`; `ThreadInstance` gains an `archivedAt: Signal<string | null>`, populated by `hydrate()` the same way `threadType` already is.
- New `archiveThread(id)` / `unarchiveThread(id)`, alongside the existing `renameThread`/`deleteThread`. `archiveThread` duplicates `deleteThread`'s existing "redirect away if this was the active thread" handling (D8).

`ui/src/components/thread-sidebar.tsx`:

- `ThreadRow`'s dropdown gets a plain "Archive" item next to Rename/Regenerate title/Copy thread ID/Delete — no inline confirm step (D7).

`ui/src/pages/threads/index.tsx`:

- The "Report" column becomes "Actions": the existing `ThreadReportButton` plus a new Archive/Unarchive icon button, rendered only for `t.type === 'chat'` rows (D1/D4) — other types keep just the Report button.
- `FILTER_TABS` gains `'archived'` as a client-side filter on `t.archivedAt != null` (a status, not a new `ThreadType`), with its own badge (D5).

New `ui/src/pages/chat/archived-thread-view.tsx`, a sibling to the existing `task-run-view.tsx` with the same self-contained shape (ADR-0029): takes `threadId` as a prop, calls `useThreadInstance(threadId).hydrate()` directly, renders the message list via the existing `ThreadMessageItem`, no `ChatInput` — a static "This thread is archived — read-only" banner with an Unarchive button in its place.

`ui/src/pages/chat/index.tsx` (`ChatRoot`):

- The `mode` signal (`'chat' | 'run' | 'resolving'`) gains `'archived'`. The existing hydrate-then-branch logic (`if (instance.threadType.value === 'task') mode.value = 'run'; else { mode.value = 'chat'; switchThread(id); }`) gets a new arm checked first: `else if (instance.archivedAt.value) mode.value = 'archived'`, so only a genuinely open thread ever reaches `switchThread()`.

Settings UI: the existing Agent Behavior / Chat panel gets one new numeric field for `sidebarRetentionDays`, wired through the already-generic `chat` PATCH.

---

## Self-review

- **Placeholders:** none — every decision above resolves to a concrete file/function; nothing marked TODO.
- **Internal consistency:** D1 (chat-only) is carried through consistently in D4 (Actions column scoped to chat rows), the route's 400 on a non-chat archive attempt, and the Non-goals list. D13/D15 agree: the sidebar's own fetch is the only filtered one, and an aged-out thread is otherwise indistinguishable from any other thread.
- **Scope check:** every item in Non-goals was explicitly raised and ruled out during grilling, not assumed.
- **Ambiguity check:** the one real ambiguity found while writing this up — `task`-thread guard not actually covering `/hitl` — is called out in D2/ADR-0028 rather than quietly papered over.
