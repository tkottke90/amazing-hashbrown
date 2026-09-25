# Live Event Broadcast — Standing SSE Channel for Background Task Events

**Date:** 2026-09-23
**Status:** Draft
**Related:** Manual testing of PR #200 (`create_tasks` batch tool + task-dependency system)

---

## Problem

A task's agent run can pause on a HITL prompt (e.g. a `shell_exec` approval) while the human isn't
actively driving an interactive chat turn on that thread. Today, nothing tells the browser this
happened. The prompt is durably persisted to `thread_messages` and, if a live per-turn SSE
connection happens to already be open on that exact thread at that exact moment, it's also pushed
over it — but a background task run isn't triggered by a browser request at all, so there's
essentially never a live connection to push to. The human only discovers the prompt is waiting by
navigating away from the chat thread and back, which forces a fresh `GET` (`hydrate()` in
`ui/src/hooks/use-thread.ts`) that re-scans thread history and finds it.

This is a structural gap, not a bug in any one code path:

- `ui/src/hooks/use-thread.ts` only opens an SSE stream inside `sendMessage()` /
  `submitHitlAnswer()` / `retryTurn()` — i.e. only for the duration of a turn the browser itself
  POSTed. There is no standing connection.
- `task-scheduler.ts` already has a `registerQueueBroadcast()` / `_broadcast` hook designed for
  exactly this kind of out-of-band push, feeding `emitQueueUpdate()` — but nothing in the codebase
  ever calls `registerQueueBroadcast()`. It's dead code, already flagged as a known gap in
  `docs/superpowers/specs/2026-08-27-automated-task-execution-design.md` and
  `2026-08-25-webhook-task-trigger-design.md`.
- The task/Kanban list (`ui/src/hooks/use-tasks.ts`'s `tasks`/`queueState` signals) is kept
  "live" only by a 10s `setInterval(() => refreshQueue(), 10_000)` in `thread-sidebar.tsx`
  (queue position/running state only) and by explicit refetches tied to page mounts and local
  mutations (full task records) — nothing pushes a background status change either.

### Why not WebSockets?

Considered and rejected. The only thing actually missing is one-directional: server → client push
for events nobody's listening for. Writes (HITL answers, chat messages) are already plain POSTs and
have no latency or architectural pressure pushing them toward a socket — REST gives retries, normal
auth/logging middleware, and no new transport to reason about. A WebSocket rewrite would also mean
replacing the per-turn SSE machinery that already works (`active-sse-writer.ts`, `stream-handler.ts`'s
`writeSseEvent`, every route's response-streaming shape, `use-thread.ts`'s `consumeSsePost`) to solve
a gap a much smaller, additive change already covers. This is also a single-user, local-machine
harness, not a multi-user real-time product, so the latency/overhead advantages WebSockets have over
SSE barely register at this scale.

---

## Non-goals

- Replacing or modifying the existing per-turn interactive chat SSE (`active-sse-writer.ts`,
  `stream-handler.ts`, `use-thread.ts`'s `consumeSsePost`). That continues to own live
  token-by-token streaming for a turn the user is actively driving. This design adds a second,
  separate channel for out-of-band background events; it doesn't touch the first one.
- WebSockets, or any bidirectional transport. See above.
- Streaming full HITL prompt content (question text, choices, command, etc.) or full task records
  over the new channel. Broadcast payloads are deliberately minimal (just enough to identify what
  changed); the frontend reacts by refetching from the existing REST endpoints, not by rendering
  the broadcast payload directly.
- A visual "live updates connected/disconnected" indicator in the UI. `EventSource` reconnects on
  its own within a few seconds; this isn't worth new UI surface.
- Replaying events missed while a connection was down. The channel carries transient signals, not a
  durable log — a one-time reconciliation fetch on (re)connect (see Error handling) closes the gap
  instead.
- Any change to `TaskQueueEntry`/`Task` REST response shapes, or to how the Kanban board renders —
  only how its backing signals get refreshed.

---

## Design

### 1. Architecture overview

A new, permanent-lifetime SSE endpoint (`GET /api/v1/events`) sits alongside the existing per-turn
chat SSE. The browser opens exactly one `EventSource` to it once, in `App()` (`ui/src/app.tsx`), and
keeps it open for the life of the tab — regardless of which page or workspace is currently active,
matching where the existing global `tasks`/`queueState` signals already live. The backend keeps a
small in-memory registry of connected clients (supporting multiple simultaneous tabs) and fans out
three event types to all of them: `task_queue_update` (already built, just needs a real transport),
`hitl_prompt`, and `task_completed` (both new).

### 2. Shared event type

A new discriminated union, `AppBroadcastEventSchema`, added to `lib/llm-common-types/src/chat/`
alongside the existing `ChatSSEEventSchema` — kept as its own type rather than folded into it, since
these events belong to a different channel with a different lifecycle (not turn-scoped; no
`messageId`/`seq` concepts).

```ts
const TaskQueueUpdateSchema = z.object({
  type: z.literal('task_queue_update'),
  queue: z.array(TaskQueueEntrySchema),
  running: z.array(TaskQueueEntrySchema),
});

const HitlPromptBroadcastSchema = z.object({
  type: z.literal('hitl_prompt'),
  threadId: z.string(),
  taskId: z.string(),
});

const TaskCompletedSchema = z.object({
  type: z.literal('task_completed'),
  threadId: z.string(),
  taskId: z.string(),
  outcome: z.enum(['done', 'failed', 'cancelled']),
});

export const AppBroadcastEventSchema = z.discriminatedUnion('type', [
  TaskQueueUpdateSchema,
  HitlPromptBroadcastSchema,
  TaskCompletedSchema,
]);
export type AppBroadcastEvent = z.infer<typeof AppBroadcastEventSchema>;
```

`TaskQueueEntrySchema` may need to be added alongside this if `TaskQueueEntry` is currently only a
TS interface rather than a Zod schema — verify at implementation time rather than duplicating the
shape if a schema already exists.

### 3. Backend: registry, endpoint, and wiring

**New module**, `api/src/services/broadcast.ts` — a standalone registry with no dependency on the
agents/stream-handler import chain (same shape as `active-sse-writer.ts`, just fan-out instead of
one-writer-per-thread):

```ts
const _clients = new Set<(event: AppBroadcastEvent) => void>();

export function registerBroadcastClient(writer: (event: AppBroadcastEvent) => void): void {
  _clients.add(writer);
}
export function unregisterBroadcastClient(writer: (event: AppBroadcastEvent) => void): void {
  _clients.delete(writer);
}
export function broadcast(event: AppBroadcastEvent): void {
  for (const writer of _clients) writer(event);
}
```

**New route**, `GET /api/v1/events` — sets SSE headers, wraps `res.write` as a writer function,
registers it via `registerBroadcastClient`, and unregisters it on `req.on('close', ...)`. This is
important: `EventSource` auto-reconnects on drop, so a stale writer left in the registry after a
reconnect would silently accumulate dead entries over time.

**Wiring `task_queue_update`**: `task-scheduler.ts`'s existing `emitQueueUpdate()` currently calls a
single-slot `_broadcast` callback that nothing registers — that indirection existed only to avoid a
circular import with `stream-handler.ts` (`registerQueueBroadcast()` was injected via the
constructor for that reason). Since `broadcast.ts` is a standalone module with no dependency on that
chain, `task-scheduler.ts` can import and call `broadcast()` directly. The entire
`registerQueueBroadcast`/`_broadcast` mechanism is removed and replaced by a real import.

**Wiring `hitl_prompt`/`task_completed`**: rather than adding calls at every place
`task-execution.ts` currently sets a terminal or waiting outcome (there are several branches, both
in the graceful path and across the catch block's five cases), this hooks at a single choke point —
`executeTask()`'s `finally` block. `finalOutcome` is already a single variable every branch assigns
before reaching `finally`, and `threadId`/`task.id` are already in scope there:

```ts
if (finalOutcome === 'waiting_on_user') {
  broadcast({ type: 'hitl_prompt', threadId, taskId: task.id });
} else if (finalOutcome === 'done' || finalOutcome === 'failed' || finalOutcome === 'cancelled') {
  broadcast({ type: 'task_completed', threadId, taskId: task.id, outcome: finalOutcome });
}
```

`'blocked'` (a user-initiated pause, not a HITL wait) deliberately broadcasts neither event — the
queue update already reflects it, and there's no thread-side content for the chat view to react to.
This means zero changes to any of `task-execution.ts`'s existing outcome-setting branches, just one
addition reusing state that's already centralized in `finally`.

### 4. Frontend: the live-events hook

**New file**, `ui/src/hooks/use-live-events.ts`, exporting `connectLiveEvents()`, called once from
`App()`'s `useEffect`. It opens `new EventSource('/api/v1/events')` and dispatches by event type:

- **`task_queue_update`** → `queueState.value = { queue, running }` directly (no fetch — the
  payload already matches that signal's shape 1:1). This is what replaces `thread-sidebar.tsx`'s
  `setInterval(() => refreshQueue(), 10_000)`.
- **`task_completed`** → locally patches the matching entry in `tasks.value` to the given outcome
  (mapping `done`/`failed`/`cancelled` onto `Task.status`), in the same optimistic-local-patch style
  `use-tasks.ts`'s other mutators (`cancelTask`, `pauseTask`, etc.) already use — no fetch needed,
  since the event already says exactly what changed. This is also what keeps the Kanban board's
  status columns live for a background task without navigating away and back. If
  `activeThreadId.value === event.threadId`, also triggers a refetch of that thread's messages.
- **`hitl_prompt`** → same local patch, to `status: 'waiting_on_user'`, plus the same
  "refetch if it's the open thread" check.

`es.onerror` needs no manual reconnect logic — `EventSource` retries on its own with built-in
backoff.

Exactly how `use-thread.ts` exposes a "refetch this thread's messages" function callable from
outside its own hook instance (reusing `hydrate()`, or a thin wrapper around it) is an
implementation-time detail to confirm against the actual code, not assumed here.

### 5. Error handling & reconnection

- **Keepalive**: `GET /api/v1/events` sends a periodic SSE comment line (`: keepalive\n\n`, no
  `data:`) every ~20s so idle connections aren't silently killed by a proxy/browser timeout and
  don't trigger unnecessary reconnects.
- **Reconnection**: handled entirely by `EventSource`'s built-in retry. Since the channel carries
  transient signals rather than a durable log, a connection gap doesn't lose anything permanently
  (the underlying task/queue state in the DB is unaffected) — but to close the gap cleanly,
  `connectLiveEvents()` triggers one reconciliation fetch (`refreshQueue()` + `refreshTasks()` for
  whatever's currently loaded) whenever the connection opens, including on reopen after a drop.
- **Server restart**: the in-memory registry just resets; clients reconnect (via `EventSource`'s own
  retry) and get the reconciliation fetch above.
- No visual connected/disconnected indicator (see Non-goals).

---

## Testing

**Backend (Mocha/Chai):**

- `broadcast.ts` — unit tests: register → broadcast delivers to it; unregister → broadcast no
  longer delivers; multiple registered writers all receive the same event (covers multi-tab
  support).
- `GET /api/v1/events` — orchestration test over a real HTTP connection (this repo already has
  precedent for testing SSE-shaped routes this way, e.g. `workspace-chat.route.test.ts`), asserting
  a connected client receives an event pushed via `broadcast()`, and that aborting the client
  connection (via `AbortController`, since this stream never ends on its own) results in the
  server-side writer being unregistered.
- `task-scheduler.ts` — spy on the new direct `broadcast()` import, confirm `emitQueueUpdate()`
  calls it with the current `{queue, running}` shape.
- `task-execution.ts` — extends the existing fake-agent test harness in `task-execution.test.ts`:
  for each `finalOutcome` category (`waiting_on_user`, `done`, `failed`, `cancelled`, `blocked`),
  spy on `broadcast()` and assert it's called with the right event (or not called, for `blocked`).

**Frontend (Jest):**

- `use-live-events.ts` — unit tests with a small fake `EventSource` (jsdom has no real
  implementation) dispatching `message` events manually: `task_queue_update` sets `queueState.value`
  correctly; `task_completed`/`hitl_prompt` patch the matching entry in `tasks.value`; the
  "refetch if it's the open thread" branch fires only when `activeThreadId` matches the event's
  `threadId`.

**E2E (Playwright):** one scenario confirming a HITL prompt appears in the chat view live, without a
reload — per this repo's own convention (`e2e/AGENTS.md`) for state that's slow/hard to reach live,
mock the task's interrupt via `page.route()` rather than running a background task through a real
LLM.
