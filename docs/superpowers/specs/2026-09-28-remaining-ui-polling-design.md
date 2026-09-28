# Remaining UI Polling and Request-Log Noise — Design

Issue: [#205](https://github.com/tkottke90/amazing-hashbrown/issues/205)

## Background

The standing live-events SSE channel (`GET /api/v1/events`,
`ui/src/hooks/use-live-events.ts`; see
`2026-09-23-live-event-broadcast-design.md`) already replaced the 10s task
queue poll. Issue #205 tracks what's left:

1. The AfterAgent thread-list poll in `ui/src/hooks/use-thread.ts`.
2. Request-log noise from `api/src/middleware/request-logger.ts`.
3. A suspected fetch fan-out from `refreshTasks()` on every `task_queue_update`.

Outcome: (1) is replaced with a broadcast event, (2) gets a level policy, and
(3) is closed out with no code change — measurement shows it isn't a problem
(see §3).

## 1. AfterAgent live event

### Shared schema — `lib/llm-common-types/src/chat/broadcast-events.ts`

- Add `AfterAgentStateSchema`, a Zod union:
  - `{ status: 'idle' }`
  - `{ status: 'running' }`
  - `{ status: 'done'; outcome: 'identified' | 'no-op' | 'error'; finishedAt: string }`
- Export `type AfterAgentState = z.infer<typeof AfterAgentStateSchema>`.
- Add `AfterAgentStateEventSchema`:
  `{ type: 'after_agent_state', threadId: string, state: AfterAgentState }`,
  and register it in `AppBroadcastEventSchema`.
- Replace the two hand-written `AfterAgentState` types
  (`api/src/agents/after-agent.ts` and `ui/src/hooks/use-thread.ts`) with
  imports of the shared type, so the wire contract and both ends can't drift.

### API — `api/src/agents/after-agent.ts`

- Add `setAfterAgentState(threadId, state)`: writes `afterAgentStatus` and
  calls `broadcast({ type: 'after_agent_state', threadId, state })`.
- The `running` write (currently a direct `afterAgentStatus.set`) and
  `setAfterAgentDone` both go through it. No other code writes the map, so
  every transition broadcasts.
- The event carries the full state; the client patches without fetching.
- The lazy `DONE_TTL_MS` sweep back to `idle` in `getAfterAgentState` does
  not broadcast. The client's indicator already hides `done` after its own
  2.5s flash (`ui/src/components/after-agent-indicator.tsx`).

### UI

`ui/src/hooks/use-live-events.ts`:

- New `after_agent_state` case: replace `afterAgentState` on the entry in
  `threads.value` whose `id` matches `event.threadId`. No matching entry →
  no-op.
- `es.onopen` adds `refreshThreadList()` to its reconciliation fetches, so an
  event missed during a reconnect can't leave a thread stuck at `running`.

`ui/src/hooks/use-thread.ts`:

- Delete `startAfterAgentWatch`, `_afterAgentPollTimer`,
  `_afterAgentPollStartedAt`, `AFTER_AGENT_POLL_INTERVAL_MS`,
  `AFTER_AGENT_POLL_MAX_MS`, and the `startAfterAgentWatch()` call in the
  `stream_done` handler.
- Keep the existing `refreshThreadList()` call in `stream_done` — it picks up
  title and ordering changes, unrelated to AfterAgent.
- Update the comments on `AfterAgentState` / `activeThreadAfterAgentState`
  that refer to the poll loop.

Side effect: every open tab now sees the indicator, not only the tab that
sent the turn.

### Accepted race

`stream_done`'s `refreshThreadList()` and the `running` broadcast travel on
different connections. If the list fetch reads `idle` on the server but its
response lands after the `running` patch, it overwrites `running` with
`idle` and the spinner is lost for that turn. The subsequent `done` event
still arrives and flashes the outcome, so the UI never settles in a wrong
state. Fixing this needs per-thread version stamps, which isn't justified
for a best-effort indicator.

## 2. Request logger — `api/src/middleware/request-logger.ts`

In the `close` handler, pick the level from the request's outcome:

- `GET` or `HEAD` with `res.statusCode < 400` → `debug`
- Everything else (mutations, any 4xx/5xx) → `info`

An aborted request keeps Express's default status of 200, so it can't be
told apart by status — it's judged by method like any other request.

Message and metadata are unchanged; only the level changes.

Effect: static assets (`requestLogger` runs before `express.static` in
`api/src/app.ts`), `/threads`, `/tasks`, `/tasks/queue`, health, upload
status, and the `/events` SSE connection's close all drop out of default
output and reappear with `LOG_LEVEL=debug`. The file transports in
`api/src/config/logger.ts` are pinned at `info`, so demoted lines never reach
`app.jsonl` — intended.

## 3. `refreshTasks()` on `task_queue_update` — no change

`task_queue_update` is emitted only by `TaskScheduler.wake()`
(`api/src/services/task-scheduler.ts`), which runs once per enqueue or
task-mutating HTTP call and once per task completion. A task costs roughly
two refetches over its entire runtime, versus six per minute under the old
10s poll.

The unconditional refetch is also what keeps task _status_ current in
`tasks.value` for transitions no other event patches: `ready → running` for
the next task in a batch, cron re-runs of an existing task, dependency
`blocked`, and pause/cancel from another tab. A "refetch only for unknown
task ids" guard would regress all of these.

Post this analysis on #205 when the PR lands.

## Out of scope

- **`ui/src/pages/chat/task-run-view.tsx` 4s rehydrate.** The only live
  stream of a running task's intermediate messages; broadcasts fire only at
  start, HITL, and completion. Replacing it needs per-message task
  broadcasts — a separate feature.
- **Upload status polling** (`ui/src/pages/wiki/upload-wiki-form.tsx`).
  Scoped to an active upload.
- **SharedWorker / multi-tab.** One idle SSE connection per tab is
  negligible.

## Testing

Developer tests:

- `api/src/middleware/request-logger.test.ts` (new) `[unit]`: GET 200 logs at
  `debug`; POST 200 logs at `info`; GET 404 logs at `info`; GET 500 logs at
  `info`. Asserts on level — the behaviour under change — not message text.
- `api/src/agents/after-agent.test.ts` `[unit]`: a run broadcasts
  `after_agent_state` with `running` then `done` for the thread, with the
  correct `outcome` for an identified run, a no-op early return, and the
  error path.
- `lib/llm-common-types` `[unit]`: `AppBroadcastEventSchema` accepts a valid
  `after_agent_state` event and rejects one with an invalid `state`.
- `ui/test/use-live-events.test.ts` `[unit]`: the event patches only the
  matching thread's `afterAgentState`; an unknown `threadId` leaves
  `threads.value` unchanged; `onopen` fetches `/api/v1/threads`.
- `ui/test/use-thread.test.ts` `[unit]`: after `stream_done`, advancing fake
  timers well past 3.5s produces no further `/api/v1/threads` fetches.

E2E — `e2e/tests/after-agent-status.spec.ts` (suite 10, `@smoke`, CI-safe).
This suite already mocks `/api/v1/threads` and owns the indicator selectors;
none of its existing tests depend on the poll.

- A mocked `after_agent_state` `running` broadcast turns an idle row's kebab
  into the spinner without a reload.
- A mocked `done`/`identified` broadcast turns a running row's spinner into
  the success checkmark.
- Only the first thread-list request is answered; later ones are held, so
  the broadcast is the only thing that can change the row.

No eval: nothing here changes prompts or model behaviour.
