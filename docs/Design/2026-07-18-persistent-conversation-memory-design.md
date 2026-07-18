# Persistent Conversation Memory Design

**Date:** 2026-07-18
**Status:** Draft
**Related:** [`TODO_LIST.md`](../../TODO_LIST.md)

## Purpose

Design the first outstanding item on `TODO_LIST.md`: survive API restarts without losing conversation history, and establish SQLite as the shared persistence layer for downstream systems. In practice this ticket ended up absorbing a meaningful slice of the separately-listed "Multi-Conversation Support" item too — persisted history is only useful if there's a way to see and switch between past threads, so this is both an API and a UI change, not the backend-only scope the TODO entry originally described.

## Background

Today, `MemorySaver` (`api/src/agents/chat-agent.ts`) holds all conversation state in process memory — an API restart wipes every conversation. The artifact store has the same problem but is out of scope here (separate TODO item). Compounding this: `ui/src/hooks/use-thread.ts` generates a brand-new `threadId` via `crypto.randomUUID()` on every page load, and there is currently no endpoint to fetch a thread's past messages — the UI only ever builds its message list from a live SSE stream. So persisting checkpoints alone, without addressing either of those, would be invisible: refreshing the page would still start a fresh, empty, orphaned thread every time.

A shared `better-sqlite3` connection already exists (`api/src/index.ts`), opened once and passed to `ObservabilityStore`, the usage/cost tracker, and the evaluation store. Its own comment already flags the intent: _"Future stores (Task System, Persistent Memory) receive the same db instance."_ This design follows that lead.

## Decisions Locked In

Brainstormed with the user first. Key decisions:

- **Two persistence layers, not one.** LangGraph's own checkpointer remains the source of truth for _agent execution state_ (tool-call sequencing, pending HITL interrupts, resumability) — it is not repurposed as a UI data source. A separate `thread_messages` table is a read-optimized projection, written alongside the SSE events the server already emits, so history hydration needs zero translation from LangGraph's internal checkpoint format.
- **Checkpointer**: `SqliteSaver` from `@langchain/langgraph-checkpoint-sqlite`, constructed directly from the existing shared `db` instance (`new SqliteSaver(db)`) — no new file, no new env var, no separate connection.
- **UI shape**: a persistent sidebar thread list (title + timestamp, click to switch, "new conversation" action) — not a dropdown, not full client-side routing. `/thread/:id` URLs and a dedicated home page stay out of scope (separate "Home / Conversation List Page" TODO item).
- **Titles**: truncated first message by default, user-editable inline, plus a manual "regenerate via LLM" action. Never automatic/silent LLM title generation.
- **Deletion and forking** are both in scope for this ticket.
- **Turn failure**: failed turns are visible and retryable, not silently dropped. Retry preserves the failed attempt as history rather than overwriting it, gated behind an opt-in visibility setting.

---

## Data Model

### Checkpoint state (LangGraph, via `SqliteSaver`)

`chat-agent.ts`'s `checkpointer` changes from `new MemorySaver()` to `new SqliteSaver(db)`, where `db` is the same shared connection `index.ts` already opens and passes to the other stores. `SqliteSaver` manages its own internal tables (`setup()`); nothing else about `chat-agent.ts` changes.

### `threads` table (new — `ThreadStore`, `api/src/services/thread-store.ts`)

Follows the existing `BaseStore`/`DbMigration` pattern used by `ObservabilityStore` (`lib/observability/src/store.ts`). Next free migration version across the shared DB is `4` (observability=1, cost-store=2, evaluations=3).

```sql
CREATE TABLE threads (
  id                     TEXT PRIMARY KEY,   -- same value as LangGraph's thread_id
  title                  TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  forked_from_thread_id  TEXT,               -- lineage only, not FK-enforced
  forked_from_seq        INTEGER
);
```

**Row lifecycle:** no dedicated "create thread" call. The first `POST /api/v1/chat/:threadId` for a given id upserts the row (`title` = first ~50 chars of the message); every subsequent turn bumps `updated_at`. A thread that never receives a message never gets a row, so opening "new conversation" and not sending anything doesn't clutter the list.

**`updated_at` also bumps on rename (`PATCH`) and `generate-title`** — any edit to a thread counts as activity and moves it to the top of the sidebar, not just new messages.

**Dangling lineage:** if a thread is deleted, any threads forked from it keep their `forked_from_thread_id` value pointing at a now-missing row. This is intentional and harmless — a fork already copied its full checkpoint lineage and message history at fork time, so it has no runtime dependency on the original thread continuing to exist. The UI falls back to a generic "Forked" label if the referenced title can't be resolved.

### `thread_messages` table (new — same store)

```sql
CREATE TABLE thread_messages (
  id             TEXT NOT NULL,        -- the UI's existing ThreadMessage id (msgId / toolCallId / promptId)
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  seq            INTEGER NOT NULL,     -- display order within the thread
  kind           TEXT NOT NULL,        -- 'user' | 'assistant' | 'tool_call' | 'hitl_prompt' | 'wiki_update' | ...
  status         TEXT,                 -- assistant: 'streaming' | 'done' | 'error'; tool_call: 'pending' | 'done' | 'interrupted'
  retry_of       TEXT,                 -- id of the row this row retried, if any
  checkpoint_id  TEXT,                 -- LangGraph checkpoint id, stamped when an assistant row reaches 'done'
  payload        TEXT NOT NULL,        -- the ThreadMessage object, JSON-serialized, verbatim
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (thread_id, id)
);
CREATE INDEX idx_thread_messages_thread ON thread_messages(thread_id, seq);
```

**Composite primary key** (`thread_id`, `id`) rather than `id` alone — message ids are only meaningful scoped to a thread, and this lets a forked copy preserve the original ids without a remapping pass.

**`seq` generation:** `SELECT COALESCE(MAX(seq), 0) + 1 FROM thread_messages WHERE thread_id = ?`, computed inside the same insert call in `ThreadStore`. `better-sqlite3` is synchronous and single-connection, so this is atomic in practice for personal use — no separate sequence table needed.

**Write points**, all in `stream-handler.ts` alongside the `writeSseEvent(...)` calls that already exist for each of these — inserting the finalized/updated row, never on streaming deltas:

- `user` message → inserted once, when the turn starts.
- `assistant` message → **inserted at turn start** (`status: 'streaming'`), then updated in place to `status: 'done'` (with final content, `checkpoint_id` stamped from `agent.graph.getState(config)`) or `status: 'error'` on failure. Inserting eagerly (not only on success) guarantees a row always exists to mark as failed — see "Turn Failure & Retry" below.
- `tool_call` → inserted on `tool_call_start` (`status: 'pending'`), updated on `tool_call_end` (`status: 'done'`, outputs).
- `hitl_prompt` → inserted on emission (`status: 'pending'`), updated when `POST /chat/:threadId/hitl` resolves it (`status: 'answered'`, answer).
- `iframe` / `audio` / `wiki_update` → inserted once, complete as emitted.

**Fidelity note:** this covers user/assistant text, tool call summaries, HITL prompts, and rich chips (iframe/audio/wiki_update) exactly as the live UI rendered them — full fidelity, since it's a direct persistence of what was already emitted, not a reconstruction from LangGraph internals.

### Fork mechanics

**Constraint:** forking is only valid at a completed turn — an assistant row with `status: 'done'`, not mid-stream and not while a HITL prompt is pending-unanswered. Enforced server-side.

**Resolution:** given a target `atSeq`, find the nearest assistant row with `status = 'done'` and `seq <= atSeq`; use its `checkpoint_id`.

**Copy:** fetch that checkpoint tuple via `checkpointer.getTuple({ configurable: { thread_id, checkpoint_id } })`, re-`put()` it under a freshly generated `thread_id`. Copy `thread_messages` rows where `seq <= atSeq` into the new `thread_id` (ids preserved, per the composite PK). Insert a new `threads` row with `forked_from_thread_id`/`forked_from_seq` set.

---

## API Surface

| Method   | Path                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/threads`                                          | List all threads for the sidebar: `{ id, title, createdAt, updatedAt, forkedFromThreadId?, forkedFromSeq? }[]`, ordered by `updatedAt` desc. No pagination for v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET`    | `/api/v1/threads/:id`                                      | Hydrate a thread: `{ id, title, createdAt, updatedAt, forkedFromThreadId?, forkedFromSeq?, messages: ThreadMessage[] }`. `404` if the thread has no rows yet — UI treats that as "start empty," not an error. Accepts `?showErrors=true` to override the `chat.showErrorMessages` config default for this request. **Soft-capped to the most recent ~200 messages** (by `seq`) — older history isn't returned; no `load more` affordance in v1 (see "Out of Scope").                                                                                                                                                      |
| `PATCH`  | `/api/v1/threads/:id`                                      | Rename. Body `{ title }`, returns the updated thread row, bumping `updated_at`. `404` if the thread doesn't exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DELETE` | `/api/v1/threads/:id`                                      | Deletes the `threads` row, its `thread_messages` rows, and calls `checkpointer.deleteThread(id)` to purge LangGraph state. `404` if the thread doesn't exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST`   | `/api/v1/threads/:id/fork`                                 | Body `{ atSeq }`. Returns the new thread fully hydrated (same shape as `GET /:id`) in one round trip. `400` if `atSeq` doesn't resolve to a completed-turn checkpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST`   | `/api/v1/threads/:id/generate-title`                       | Body `{ provider?, model? }` (mirrors the chat endpoints' optional override pattern — currently always omitted, since the UI has no provider/model selector yet). Returns `{ id, title, createdAt, updatedAt }`, bumping `updated_at`. A single plain (non-streaming, non-agentic) LLM completion over the thread's `user`/`assistant` message content — capped to the last ~20 such messages, then hard-truncated to a ~4000-char budget as a backstop — run through `ObservabilityCallbackHandler` tagged with `threadId` so it counts toward usage/cost tracking. `400` on an empty thread, `500` on provider failure. |
| `POST`   | `/api/v1/chat/:threadId/retry` _(new, in `chat.route.ts`)_ | No body. Retries the thread's last turn if its assistant message is `status: 'error'`; `400` otherwise. SSE response, same shape as `POST /chat/:threadId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST`   | `/api/v1/chat/:threadId` _(existing)_                      | Now also upserts the `threads` row on first turn and writes to `thread_messages` at each of the points listed above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST`   | `/api/v1/chat/:threadId/hitl` _(existing)_                 | Now also updates the matching `hitl_prompt` row and stamps `checkpoint_id` once the resumed turn completes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## UI Flow

**State layer (`use-thread.ts`):**

- `THREAD_ID` (frozen constant) becomes `activeThreadId` (a signal), seeded from `localStorage['ah:activeThreadId']` or a fresh UUID, persisted on every change. `sendMessage`/`submitHitlAnswer`/the new `retryTurn` all read `activeThreadId.value`.
- New `threads` signal (`ThreadSummary[]`) for the sidebar, populated by `GET /threads` on mount and refetched after create/rename/delete/fork/generate-title.
- New `switchThread(id)`: if `isStreaming`, calls the existing `stopGeneration()` first, then hydrates via `GET /threads/:id` (a `404` just means empty). If the last message is a pending `hitl_prompt`, sets `pendingHitlId` so the existing answer UI works unmodified.
- New `newThread()`: same as `switchThread` but skips the fetch — nothing is persisted until the first message is sent.
- `ThreadMessage` gains a `seq` field, round-tripped from `thread_messages.seq`, so the fork action has a stable target (array index isn't safe once live-streaming messages are involved).
- New `retryTurn()`: resets the failed message locally (`status: 'streaming'`, cleared content), opens the SSE POST to `/chat/:threadId/retry`, reuses the existing `handleEvent` pipeline.

**Sidebar** (`app.tsx`'s `AppAside`, extracted to a `ThreadSidebar` component) replaces the current stub `Home`/`Settings` nav (`Settings` stays a stub — separate TODO item):

- "New conversation" action at top, wired to both a click handler and `Layout`'s existing `onAddClick` (the mobile floating **+** button already has this slot).
- Rows: title, relative timestamp, active-state highlight, "Forked from _Title_" subtitle when applicable.
- Row actions (kebab menu, `components/ui/dropdown-menu.tsx`): **Rename** (inline `<Input>` swap, Enter/blur to save, Escape to cancel), **Regenerate title** (spinner on the row while in flight), **Delete** (inline "Delete? [confirm] [cancel]" rather than a modal; if the active thread is deleted, falls back to `newThread()`).
- Clicking a row body switches to it via `switchThread(id)`.

**Fork action:** a new entry in `ChatMessage`'s existing `actions` prop (alongside the current copy action) — shown only on `user` messages and `assistant` messages with `status: 'done'`, never on anything still streaming or not yet persisted. Calls `POST /threads/:id/fork { atSeq: message.seq }`, switches straight to the returned hydrated thread, refreshes the sidebar list.

**Error visibility toggle:** a setting (persisted to `localStorage`) that, when on, passes `?showErrors=true` on hydration fetches, revealing superseded failed attempts. Defaults to reflecting the server-side `chat.showErrorMessages` config on first load.

---

## Turn Failure & Retry

**Problem:** without explicit handling, a failed turn simply has no row written, so on reload the conversation silently ends after the user's last message with no indication anything went wrong.

**Design:** the assistant row is inserted at turn start (not only on success — see write points above), so there is always a row to mark `status: 'error'` if the turn fails, in `chat.route.ts`'s catch block or any error path within `stream-handler.ts`. `threads.updated_at` still bumps on a failed turn.

**Dangling `tool_call` rows:** if the turn fails mid-sequence, any `tool_call` rows still `status: 'pending'` for that turn are swept to a new terminal status, `'interrupted'`, at the same time the assistant row is marked `'error'` — distinct from `'done'` so the transcript shows the call was genuinely in flight when things broke, not that it silently finished with an empty result.

**Retry preserves history rather than overwriting.** `retry_of` on `thread_messages` links a retry attempt back to the row it retried. A retry **inserts a new row** (fresh id, next `seq`) rather than mutating the failed one — a failed-then-retried-then-succeeded turn becomes a chain: `error(A) → error(B, retryOf=A) → done(C, retryOf=B)`.

**Visibility filter** (`GET /threads/:id`, config `chat.showErrorMessages` / `?showErrors=` override): hides a `status: 'error'` row **only if** some other row's `retry_of` points at it — i.e., only _resolved_ failures are hidden. An error row nothing has retried yet is always shown, regardless of the setting, since it's the live "this needs your attention" state. This falls out of the data model for free: a `retry_of` chain only ever extends forward, so if an error row is currently the thread's last message, nothing can point at it yet — it is definitionally unresolved.

**Config** (`api/src/config/env.ts`): new `ChatSchema = z.object({ showErrorMessages: z.boolean().default(false) })`, added to `AppConfigSchema`, exposed as `env.chat.showErrorMessages`, following the exact pattern `ObservabilitySchema`/`AfterAgentSchema` already use.

**Retry mechanics:** LangGraph checkpoints after each step, so retrying a failed turn does not need the HITL-style `Command({ resume })` mechanism — re-invoking `agent.streamEvents(null, config)` on the same `thread_id` with no new input resumes from the last good checkpoint and re-executes the failed step. **Scope constraint:** retry only applies to the thread's most recent turn — retrying something mid-history is "fork + regenerate," already covered by the fork feature, so retry doesn't need to solve that too.

Confirmed empirically against the real installed `@langchain/langgraph`/`createAgent` (not just inferred from the type signature): a scripted fake model made to throw on a specific call showed the failed turn's human message was already checkpointed and `state.next` correctly reported `["model_request"]` as the pending step; `agent.invoke(null, config)` re-executed exactly that step — no duplicated human message, correct final response. This is genuinely the LangGraph-native retry mechanism, distinct from `resumeChatToSse`'s `Command({ resume })` HITL path.

---

## Error Handling

- `thread_messages` writes during a live SSE turn are wrapped in try/catch and never block or fail the response — the same "must not break the user-visible turn" rule the AfterAgent Middleware already follows. A write failure is logged; the live conversation still completes (worst case, that turn's row is missing from history on next reload).
- `SqliteSaver` failing to initialize at boot is a hard failure (crashes startup) — consistent with how `openDatabase()` and the other stores already behave; no silent degraded mode for the persistence layer.
- If the server process crashes outright mid-turn (not a handled error), an assistant row can be left stuck at `status: 'streaming'` forever with no reconciliation. Accepted as out of scope for a personal-use MVP rather than building crash-recovery/reconciliation logic now.

---

## Testing

### Developer Tests (Mocha + Chai, no browser, no live LLM)

Per this repo's rule to always mock external services in developer tests, nearly everything here needs no live model:

- **`ThreadStore` unit tests** (`api/src/services/thread-store.test.ts`): CRUD, migration, fork-copy logic, the `retry_of` visibility filter.
- **`threads.route.ts` orchestration tests** (supertest, in-process): full request→handler→response for list/get/patch/delete/fork against a real temp DB, no LLM — fork only copies existing rows/checkpoints.
- **`generate-title` orchestration test**: mocks `createProvider(...).invoke()` as the external boundary; verifies the outbound prompt and inbound handling of success / empty-thread-400 / provider-failure-500.
- **`stream-handler.ts` changes**: orchestration tests against `/chat/:threadId` and the new `/chat/:threadId/retry` with the model mocked, verifying `thread_messages` writes at each transition (start/done/error/retry).

### E2E (Playwright)

- **CI-safe, `@smoke`/`@functional`, no `@llm`**: sidebar rendering, active-state switching, rename-input swap, delete-confirm swap — using Playwright route interception to mock `GET/PATCH/DELETE /api/v1/threads*`, per this repo's explicit allowance for API mocking in `@smoke` tests. No live model, no real seeded conversation.
- **`@user-workflow @llm`, local-only** (same pattern as `chat-send.spec.ts`/`hitl.spec.ts`): send a message, see it land in the sidebar with a truncated title, reload, confirm history rehydrates exactly, rename, delete, fork from a turn, regenerate title.
- **Failure-path `@llm` test**: force a failure (unreachable provider override), confirm the error row and Retry action appear, retry succeeds, and the `showErrorMessages` toggle reveals/hides the superseded attempt correctly.

### Evaluations (EDD)

This repo's EDD rule requires a failing eval scenario to be written _before_ implementing any new LLM-facing feature. `generate-title` is the only genuinely LLM-quality-facing piece of this design (everything else is deterministic persistence/CRUD) — retry/fork/CRUD explicitly do not belong in an eval suite, since evals judge model output quality, not software behavior.

- New `suites/thread-titles.yaml`, same shape as `wiki-search.yaml`: `deterministic` scenarios (non-empty, under ~60 chars, no wrapping quotes/trailing punctuation) plus `semantic`/`llm-judge` scenarios (given a fixed sample conversation, does the generated title actually reflect the topic).
- Run via `npm run eval -- --suite thread-titles --model ollama`, locally, same as every other suite — not part of the automated CI gate (no live LLM in CI).

---

## Out of Scope

- Client-side routing / bookmarkable `/thread/:id` URLs (separate "Home / Conversation List Page" TODO item).
- Pagination on the thread list.
- Cursor pagination / "load older messages" for a single thread's history — `GET /threads/:id` is soft-capped to the most recent ~200 messages instead. Accepted for v1 since realistic personal-use conversation lengths stay well under that; revisit if it turns out to bite in practice.
- Forking from a mid-stream or pending-HITL point.
- A provider/model selector UI — doesn't exist yet; `generate-title` uses the server default until that's built.
- Thread search/filter in the sidebar.
- Crash-recovery reconciliation for assistant rows stuck at `status: 'streaming'` after an unhandled server crash.
- Multi-tab/multi-device coordination — `activeThreadId` lives in `localStorage`, shared per browser origin. Sending messages to the same thread from two open tabs at once can race (interleaved SSE responses, competing writes). Accepted as a known limitation, not solved here.
