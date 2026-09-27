# Agent Wait (Timed Wake-ups) — Design

**Date:** 2026-09-27
**Status:** Draft
**Related:** [Issue #191](https://github.com/tkottke90/amazing-hashbrown/issues/191), [Autonomous collaboration architecture](../../Design/2026-07-10-autonomous-collaboration-architecture.md) ("Agent Self-Schedule"), [Cron task triggers design](./2026-09-26-cron-task-triggers-design.md), [Sub-agent tooling design](./2026-09-09-sub-agent-tooling-design.md)

---

## Goal

Let an agent in an interactive chat **wait** for something external (a deploy rolling out, CI running, a server booting) without sleeping inside its turn: it schedules a wake-up, ends its turn, and is resumed in the same thread with its own note when the wake-up fires. Also stop the chat UI from reporting a long-running turn as a provider connection failure.

---

## Problem

Issue #191 attributes the error to a `shell_exec` timeout. That's not what happens:

- **`shell_exec` has no timeout.** `lib/shell-executor/src/shell-executor.ts` spawns with no `timeout`, `kill` or `AbortSignal`; the config (`lib/shell-executor/src/config.ts`) has no timeout field.
- **The error text is a client-side label.** `ui/src/hooks/use-thread.ts` (the three `catch` paths around lines 657, 701, 752) turns _any_ failed stream read into `stream_error` with `errorCategory: 'network'`, which `chat-error-detail.tsx` renders as "Couldn't reach the provider — check your connection." `TypeError: Error in input stream` is Firefox's message for a failed fetch body read.
- **The actual cause is an idle SSE connection.** The per-turn chat stream has no keepalive (only `/api/v1/events` sends one). A `sleep 600` produces zero bytes for ten minutes, and the browser or an intermediate proxy drops the connection. The server never notices (no `res.on('close')`) and finishes the turn anyway.
- **Sleeping in a turn is expensive even when it doesn't error.** The whole turn runs inside `getProviderQueue().withSlot(...)` (`stream-handler.ts:974`) and holds the per-thread mutex. A 15-minute shell sleep holds a provider slot for 15 minutes; queued tasks on that provider wait behind it.

The infrastructure for the right shape mostly exists: `runHeadlessTurn` (`agents/headless-turn.ts`) runs a system-initiated turn in an existing thread (used today by sub-agent completions), `enqueuePendingTurn` (`agents/pending-thread-turns.ts`) serialises it behind a live turn, and `CronRegistry` (`services/cron-registry.ts`) is a proven pattern for database-backed in-process timers. Gaps found while designing this:

- A headless turn is invisible to an open UI (nothing is broadcast), cannot be stopped (no `AbortController` is registered), and logs failures without writing anything to the thread.
- **Global chat has no busy guard.** Workspace chat refuses a turn (SSE `stream_error`) while another turn holds the thread (`workspace-chat-stream-handler.ts:166`); global chat (`stream-handler.ts`) overwrites the writer, so a user message sent during a headless turn runs a second turn concurrently on the same LangGraph checkpoint. Rare today (sub-agent completions only); routine once wake-ups exist.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                    | Rationale                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Scope: SSE keepalive + honest error labelling, and timed wake-ups.** Background-process wake-ups ("tell me when this process exits") are a separate spec. | The keepalive fix is small and independent. Process wake-ups need a job registry, output capture, orphan handling and a kill path that don't exist yet; they reuse this spec's delivery path.                                              |
| D2  | Waiting is **schedule-and-end-turn**, never block-in-turn.                                                                                                  | Blocking holds a provider slot and the thread mutex for the full wait, and depends on a long-lived HTTP connection.                                                                                                                        |
| D3  | **Chat and workspace-chat threads only.** The tools are not bound for task runs or sub-agents.                                                              | A task run settles when its turn ends; waking it requires a new "parked" run state across queue settlement, cron settlement and run history. That belongs with process wake-ups, where "wait for my tests inside a task" is the main case. |
| D4  | Reminders for the user are **not** a wake-up use case.                                                                                                      | Wake-ups exist for the agent to pause its own work. A user reminder is a one-off scheduled (`cron_once`) task.                                                                                                                             |
| D5  | Delay **10 s – 2 h**; **one pending wake-up per thread**; **chain cap of 12** consecutive wake-ups without a user message.                                  | The floor prevents a tight self-wake loop consuming provider slots; beyond 2 h it's scheduling, not waiting; the chain cap stops an unattended poll from running forever.                                                                  |
| D6  | A user message **does not cancel** a pending wake-up; a wake-up that fires during a running turn queues behind it.                                          | The agent's reason for waiting is usually unaffected by chat in between; the user can cancel explicitly.                                                                                                                                   |
| D7  | A dedicated **`thread_wakeups` table + `WakeupRegistry`**, modelled on `CronRegistry`.                                                                      | Hidden `cron_once` tasks would violate "never run a task in a shared thread". A generic timer primitive shared with `CronRegistry` is premature with one simple second consumer and would churn code merged in #213.                       |
| D8  | A **wake-up card** in the transcript with **Trigger now** and **Cancel**, plus a `cancel_wakeup` tool for the agent.                                        | A pending timer the user can't see or stop is the opacity the issue complains about.                                                                                                                                                       |
| D9  | No toasts / browser notifications. An open thread refreshes live via `/api/v1/events`.                                                                      | This is the agent's own waiting, not a user-facing alert (D4).                                                                                                                                                                             |
| D10 | `shell_exec` **refuses sleeps longer than 10 s**, pointing the agent at `schedule_wakeup`. Sleeps inside interpreters/scripts are knowingly missed.         | Models have a strong prior toward `sleep N`; a refusal at the moment of the mistake teaches small local models better than prompt text alone.                                                                                              |

---

## Non-goals

- **Background process wake-ups** (a `shell_exec` background mode with a job registry and completion wake-up). Follow-up spec; reuses §3's delivery path.
- **Parking task runs** (`running → blocked → running` on a self-scheduled trigger, `TODO_LIST.md` "agent self-scheduled wakeup").
- **Agent-created reminders:** `create_tasks` hardcodes `triggerType: 'chat'` (`create-tasks.tool.ts:103`), so the agent cannot create a `cron_once` task today. Follow-up.
- **Live token streaming of background turns** into a tab. The user sees "working…" then the finished reply.
- **A `shell_exec` timeout** or kill-on-Stop for shell commands. Belongs with background processes.
- **Aborting the server turn on client disconnect.** Letting the turn finish is correct now that the UI recovers (§1).
- **Thread-list badge** for threads with a pending wake-up.

---

## Design

### 1. SSE keepalive and `connection_lost`

**Server.** Add `startSseKeepalive(res, intervalMs = 15_000): () => void` next to `setSseHeaders`. It writes the SSE comment `: keepalive\n\n` on an interval and returns a stop function; it also stops itself on `res.on('close')`. Every per-turn SSE entry point calls it after setting headers and stops it in its `finally`: global chat send / retry / fork / HITL resume, and the three workspace-chat entry points. The client already ignores comment lines (`consumeSsePost` only reads `data:` lines).

**Broadcast.** `finalizeTurn` (and the error path of every turn runner) broadcasts `thread_turn_completed { threadId }` on `/api/v1/events`. A matching `thread_turn_started { threadId, source }` is broadcast when a headless turn starts (§3). Schemas go in `lib/llm-common-types/src/chat/broadcast-events.ts`; `source` is `'wakeup' | 'sub_agent'`.

**Client.**

- New `ChatErrorCategory` member `connection_lost`, distinct from `network` (which stays reserved for real provider network errors from `error-classification.ts`).
- The three `catch` paths in `use-thread.ts` emit `connection_lost` instead of `network`. User aborts stay excluded as today.
- `chat-error-detail.tsx` renders it as: _"Lost the live connection to the server. The agent may still be working — this thread will refresh when it finishes."_
- On `connection_lost` the thread calls `hydrate()` once, and `use-live-events.ts` re-hydrates any loaded thread on `thread_turn_completed`.

### 2. Data model

**Table `thread_wakeups`** (new migration in `thread-store.ts`):

| column          | type             | notes                                                                     |
| --------------- | ---------------- | ------------------------------------------------------------------------- |
| `id`            | TEXT PK          | uuid                                                                      |
| `thread_id`     | TEXT NOT NULL    | FK → `threads(id)` `ON DELETE CASCADE`                                    |
| `note`          | TEXT NOT NULL    | the agent's instructions to its future self                               |
| `fire_at`       | TEXT NOT NULL    | ISO timestamp                                                             |
| `status`        | TEXT NOT NULL    | `pending` \| `fired` \| `cancelled`                                       |
| `chain_depth`   | INTEGER NOT NULL | 1 when scheduled from a user-initiated turn                               |
| `created_at`    | TEXT NOT NULL    |                                                                           |
| `settled_at`    | TEXT             | set on `fired` / `cancelled`                                              |
| `settled_by`    | TEXT             | `timer` \| `trigger_now` \| `catch_up` \| `user_cancel` \| `agent_cancel` |
| `cancel_reason` | TEXT             | optional, from `cancel_wakeup`                                            |

Partial unique index: `CREATE UNIQUE INDEX thread_wakeups_one_pending ON thread_wakeups(thread_id) WHERE status = 'pending'`.

**Transcript rows** (two `ThreadMessage` kinds, each with its own typed payload):

- `wakeup` — written when the wake-up is scheduled. Payload `{ wakeupId, note, fireAt, state, settledBy?, settledAt?, cancelReason? }` — `state` mirrors the table's `status`; it is not named `status` because `toClientMessage` lets a row's own `status` column override a payload field of that name. Updated in place on every transition.
- `wakeup_fired` — written at fire time, immediately before the resulting turn. Payload `{ wakeupId, note, settledBy, lateByMs? }`. Immutable.

**`WakeupStore`** (`services/wakeup-store.ts`) is the only writer of both the table and these rows. Each transition (`schedule`, `markFired`, `cancel`) updates the table row and the `wakeup` card payload in one transaction, and each returns `null` when the row is not `pending` — that return is the race gate every caller relies on. The table is the source of truth; the card is its projection.

### 3. Registry and firing

**`WakeupRegistry`** (`services/wakeup-registry.ts`), same shape as `CronRegistry`: injectable `now` / `setTimer` / `clearTimer` / `store`, a `Map<wakeupId, handle>`, and a module singleton `getWakeupRegistry()`.

- `boot()` — lists pending rows; fires those whose `fire_at` has passed with `settledBy: 'catch_up'` and the lateness; arms the rest. Called from `index.ts` after the database opens.
- `sync(id)` — clears and re-arms from the row (no-op when not pending).
- `triggerNow(id)` — clears the timer, then `fire(id, 'trigger_now')`.
- `cancel(id, by, reason?)` — clears the timer, then `store.cancel(...)`.
- `fire(id, settledBy)` — `store.markFired(...)`; if it returns `null`, stop. Otherwise write the `wakeup_fired` row and deliver.
- No chunking past `MAX_TIMER_DELAY_MS`: the 2 h cap keeps every delay below it.

**Delivery.**

1. Resolve the agent for the thread. `resolveParentAgent` moves from `sub-agent-notification.ts` to `agents/resolve-thread-agent.ts` unchanged and both callers import it. A `null` result (thread or workspace gone) ends delivery; the wake-up stays `fired`.
2. `enqueuePendingTurn(threadId, () => runHeadlessTurn({ ..., message, wakeupDepth: row.chainDepth }))`.
3. The injected message:

   > ⏰ Wake-up (scheduled 15m ago at 3:27 PM). Your note: "<note>". Continue from where you left off.

   A catch-up appends: _"This fired 42m late because the server was offline."_

**`runHeadlessTurn` changes** (apply to sub-agent completion turns too):

- New optional param `wakeupDepth?: number`, passed as `configurable.wakeupDepth` so `schedule_wakeup` can compute chain depth.
- Registers an `AbortController` via `setActiveSseWriter`'s third argument; the existing `/stop` route then aborts it, and an abort finalizes as `cancelled` like an interactive Stop.
- Broadcasts `thread_turn_started` before streaming and `thread_turn_completed` in `finally`.
- On an unrecovered failure, writes an assistant error row through the same error-recording path interactive turns use, instead of only logging.

**Thread metadata** gains `activeTurn: boolean` (true while `getActiveSseWriter(threadId)` is set) on the thread GET response, so a reload mid-turn shows the right state.

**Busy guard.** Global chat send / retry / HITL resume refuse the turn with an SSE `stream_error` (`"This chat is busy with another turn — try again in a moment."`) when `getActiveSseWriter(threadId)` is set — the same shape workspace chat already uses. (Fork is a plain JSON route that runs no turn.)

### 4. Tools and routes

**`schedule_wakeup({ delaySeconds: number, note: string })`** (`agents/tools/schedule-wakeup.tool.ts`)

- Rejects `delaySeconds` outside 10–7200 and an empty `note` (zod).
- Rejects when the thread already has a pending wake-up: _"A wake-up is already pending (id …, fires at …). Call cancel_wakeup first if you want to replace it."_
- Chain depth = `configurable.wakeupDepth + 1` when present, else `1`. Rejects when it would exceed 12: _"You have woken yourself 12 times without the user replying. Stop waiting and report the current status to the user."_
- On success: `WakeupStore.schedule(...)` writes the row and the `wakeup` card, `getWakeupRegistry().sync(id)` arms it, and the tool returns _"Wake-up scheduled for 3:42 PM (in 15m). End your turn now; you will be resumed with your note."_

**`cancel_wakeup({ reason?: string })`** — cancels this thread's pending wake-up with `agent_cancel`; returns a plain message when there is none.

Both are built per agent (they need the thread id), bound in `buildChatAgent` and `buildWorkspaceChatAgent` only, and registered in `tool-catalog.ts` (category `built-in`, not always-on, enabled by default) so per-thread tool access can disable them.

**Routes** (`routes/v1/threads.route.ts`, handlers in `threads.handlers.ts`):

- `POST /api/v1/threads/:threadId/wakeups/:wakeupId/cancel` → `user_cancel`
- `POST /api/v1/threads/:threadId/wakeups/:wakeupId/trigger` → `trigger_now`

Both: 404 when the wake-up doesn't exist or belongs to another thread, 409 when it isn't pending, 200 with the updated card payload. Handlers use `WakeupStore`; the route calls the registry afterwards (same split as the cron routes). After a successful delete the thread delete route calls `getWakeupRegistry().clearThread(threadId)` to drop any armed timer (the row itself cascades).

### 5. Shell sleep guard

`detectLongSleep(command: string): number | null` in `lib/shell-executor/src/sleep-guard.ts` returns the total sleep in seconds when it exceeds 10, else `null`.

- Detects `sleep` as a command word at the start of the command or after `;`, `&&`, `||`, `|`, `&`, `$(`, or a backtick, and `timeout <N> sleep …`.
- Parses GNU `sleep` durations: bare seconds, `s`/`m`/`h`/`d` suffixes, decimals, multiple summed arguments (`sleep 1m 30s`).
- Ignores `sleep` inside quoted strings (`echo "sleep 600"`).
- Knowingly does not detect sleeps inside interpreters (`python -c 'time.sleep(600)'`) or scripts.

`shell_exec` runs the guard **before** the allowlist / approval interrupt, and on detection returns (not throws) a refusal, recorded in `shell_audit_log` with `outcome: 'denied'`, `source: 'sleep-guard'`:

- `schedule_wakeup` bound: _"Refused: this command sleeps for 600s. Don't wait inside the shell — call schedule_wakeup with your delay and a note, then end your turn."_
- Not bound: _"Refused: long sleeps aren't allowed in shell_exec."_

### 6. System prompt

New `waiting` section in `system-prompt.ts`, `requiresAnyOf: ['schedule_wakeup']`. Section gating in `tool-access.middleware.ts` currently uses the thread's _enabled_ tool ids, so a section can appear for an agent that never binds the tool (e.g. a task agent); it is changed to use ids that are both enabled and present in the request's bound tools. Section content:

- Use `schedule_wakeup` when you must wait for something external: a deploy, CI, a server starting, a long-running command.
- After scheduling, end your turn immediately with a one-line status for the user.
- Write the note for your future self: what to check and how (the exact command or URL).
- Never sleep in the shell.
- Don't use wake-ups to remind the user of something; that is a scheduled task.

### 7. UI

- **`WakeupCard`** (`ui/src/components/wakeup-card.tsx`) for the `wakeup` kind, composed from the existing card shell:
  - `pending`: note; "in 14m · 3:42 PM" (relative time refreshed every 30 s); **Trigger now** and **Cancel** buttons, each calling its route and applying the returned payload.
  - `fired`: "Fired 3:42 PM" plus how (timer / triggered by you / late — server was offline).
  - `cancelled`: "Cancelled by you" or "Cancelled by agent: <reason>".
- **`WakeupFiredMarker`** for `wakeup_fired`: a compact divider "⏰ Woke up: <note>".
- Both kinds are added to `ui/src/types/thread-message.ts` and dispatched in `components/thread-message.tsx`.
- **Background turn state:** the thread instance gets a `backgroundTurnActive` signal, seeded from `activeTurn` on hydrate and set/cleared by `thread_turn_started` / `thread_turn_completed`. While set, the composer shows "Agent is working (wake-up)…" with a Stop button and Send disabled. `thread_turn_completed` triggers `hydrate()`.

---

## Error handling

| Situation                                                   | Behaviour                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Cancel and fire race                                        | `WakeupStore` transitions only from `pending`; the loser gets `null` (route: 409, registry: no-op).                                    |
| Server down at fire time                                    | `boot()` fires once with `catch_up`; the injected message states the lateness.                                                         |
| Thread deleted while pending                                | Row cascades; route clears the timer; a stray timer finds no row and does nothing.                                                     |
| Workspace deleted while pending                             | Row still exists (thread may remain); agent resolution returns `null`, delivery is dropped and logged; card shows `fired`.             |
| Wake-up fires during a running turn                         | Queued via `enqueuePendingTurn`; runs when the mutex frees.                                                                            |
| User sends while a wake-up turn runs                        | Busy-guard `stream_error`; UI prevents it via `backgroundTurnActive`.                                                                  |
| Wake-up turn fails                                          | Error row written to the thread; `thread_turn_completed` broadcast; UI shows it on hydrate.                                            |
| User presses Stop during a wake-up turn                     | Turn aborted and finalized as `cancelled`.                                                                                             |
| SSE connection drops mid-turn                               | `connection_lost` shown; server finishes the turn; UI re-hydrates on `thread_turn_completed`.                                          |
| Server restart with a queued (not yet started) wake-up turn | The row is already `fired` but the in-memory pending turn is lost. Accepted: the window is the length of the running turn ahead of it. |

---

## Testing

Test names carry the `[unit]` / `[orchestration]` / `[external-orchestration]` tags per `AGENTS.md`.

**Evals first** (EDD) — new `suites/agent-wait.yaml`, failing before implementation, `purpose` on every scenario:

1. `tool-call`: "The deploy just started rolling out; check whether it succeeded in about 15 minutes." → `schedule_wakeup`, `delaySeconds` ≈ 900, non-empty `note`.
2. `tool-call`: user has just started a ~5 minute test run and asks to hear how it went → `schedule_wakeup`, not `shell_exec`.
3. `tool-sequence`: seeded `shell_exec` refusal (sleep-guard text) → next call is `schedule_wakeup`.
4. `tool-sequence`: seeded wake-up message whose note says to run a status command → the agent runs that check rather than rescheduling blindly.
5. `tool-call`: "Remind me in 10 minutes to call Sam." → `tool: '!schedule_wakeup'` (an `llm-judge` scenario can't observe tool calls — the runner never binds tools for it). Revisit when `create_tasks` supports `cron_once`.

**Unit**

- `detectLongSleep`: table-driven over every form in §5, the 10 s boundary, and false positives (quoted strings, `sleepy`, `--sleep` flags, interpreter sleeps).
- `WakeupStore`: each transition, the one-pending index, card payload kept in sync, `null` from a non-pending row.
- `WakeupRegistry` with injected timers: arm on `sync`, `boot` re-arm and catch-up, fire gate after cancel, `triggerNow` clears the timer.
- `schedule_wakeup` / `cancel_wakeup`: bounds, one pending, chain depth from `configurable.wakeupDepth`, cap at 12.
- `startSseKeepalive`: writes on interval, stops on stop-fn and on `close`.

**Orchestration**

- Fire → `enqueuePendingTurn` → stubbed agent: `wakeup_fired` row written before the turn, `thread_turn_started`/`completed` broadcast, card `fired`.
- `/stop` aborts a running wake-up turn.
- Global chat refuses a turn (busy-guard `stream_error`) while a headless turn holds the thread.
- Cancel / trigger routes via `startTestServer` + `fetch`: 200, 404 (unknown / other thread), 409 (not pending).
- `shell_exec` returns the refusal before any approval interrupt.
- Chat route emits keepalive lines on a slow stubbed stream.

**UI (Jest)**

- `WakeupCard` in each state; buttons call their routes.
- A rejected stream read yields `connection_lost` (not `network`) and triggers `hydrate()`.
- `backgroundTurnActive` disables Send and shows Stop.

**E2E** (`@user-workflow`, CI-safe via `page.route()`)

- A mocked thread with a pending wake-up renders the card; **Cancel** and **Trigger now** update it.
- An SSE response aborted mid-stream shows the `connection_lost` message, not "Couldn't reach the provider".

---

## Bookkeeping

- Add a "Timed agent wake-ups (#191)" entry to `TODO_LIST.md` "Completed Items" on the implementing branch.
- Record the follow-ups from Non-goals (process wake-ups, parked task runs, `create_tasks` `cron_once`) in `TODO_LIST.md` "Outstanding Items".
- Add a short "Wake-ups" section to `api/AGENTS.md` describing `WakeupStore` as the only writer and the registry/route split.
