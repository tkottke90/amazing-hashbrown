# Sub-Agent Tooling — Design

**Date:** 2026-09-09
**Status:** Draft
**Related:** [2026-09-09-provider-concurrency-queue-design.md](./2026-09-09-provider-concurrency-queue-design.md), [2026-09-09-task-queue-serialization-design.md](./2026-09-09-task-queue-serialization-design.md)

---

## Goal

Give the agent a tool to delegate a subtask to a fresh, isolated agent run — optionally on a different (e.g. cheaper/faster/local) provider than the calling conversation — without blocking the calling turn, without letting the model pick provider/model itself, and without any risk of unbounded recursion or concurrent workspace mutation.

---

## Problem

No sub-agent mechanism exists today. Tools are plain functions spread into a `tools: []` array at `createAgent()` call sites (`chat-agent.ts`); nothing recursively invokes agent construction. Two risks specific to sub-agents, beyond "build the tool":

1. **Overspend / infra choice.** If the calling LLM picks its own sub-agent's provider, a local-only user setup is fine, but nothing stops a paid provider from being selected by the model and burning budget unsupervised.
2. **Unbounded recursion / concurrent mutation.** A sub-agent that can itself call the sub-agent tool, or that can write files, reintroduces exactly the concurrency-safety problems the [task-queue-serialization design](./2026-09-09-task-queue-serialization-design.md) exists to prevent.

---

## Scope

**In scope:**

- A `spawn_sub_agent` tool: fire-and-forget dispatch, N invocations per turn allowed.
- Fixed provider/model per sub-agent "role," resolved from config at dispatch time — never a parameter the calling model supplies.
- Read-only tool restriction for every sub-agent run: no mutating built-in tools, no MCP tools, no `spawn_sub_agent` itself (blocks nesting).
- Durable, resumable sub-agent runs, reusing the existing Task/`TaskScheduler` infrastructure with a new discriminator rather than a parallel subsystem.
- Delivery of each sub-agent's result back to the calling ("parent") thread as its own turn, including how many sibling sub-agents from the same dispatch are still outstanding.
- A transcript-visible status marker on the parent thread for dispatch and each completion (the "interrupt" UX from the original requirements — a visual indicator, not a graph-level block).

**Out of scope:**

- MCP tool access for sub-agents (explicitly deferred to a later opt-in allowlist).
- Cancelling a running sub-agent from the parent thread — inherits whatever cancel/abort story tasks have (`active-task-abort.ts`); no new cancellation UX designed here.
- Nested sub-agent chains beyond one level — blocked by construction (§3), not configurable.

---

## Design

### 1. Why sub-agent runs are a variant of Task, not a new subsystem

A sub-agent run needs exactly the durability properties a Task already has: its own dedicated LangGraph thread, SQLite-persisted status, and crash-recovery/resume-on-restart (`WorkspaceStore.recoverRunningQueueEntries()`, `workspace-store.ts:486`, already resets a `running` row to `pending` on boot and lets the scheduler naturally re-run it against the same `thread_id` — the existing checkpoint carries prior context forward, the same "resume" semantics tasks already get today). Building a second, parallel durable-run subsystem would duplicate that logic for no benefit. Sub-agent runs are `tasks` rows with `origin: 'agent'`.

### 2. Schema

New columns on `tasks` (migration appended to `workspace-store.ts`'s `MIGRATIONS`, same pattern as the existing `thread_id` addition):

```sql
ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
ALTER TABLE tasks ADD COLUMN parent_thread_id TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_group_id TEXT;
ALTER TABLE tasks ADD COLUMN role TEXT;
```

| column | meaning |
|---|---|
| `origin` | `'user'` (existing behavior, default) or `'agent'` (spawned by `spawn_sub_agent`). |
| `parentThreadId` | thread to deliver the completion notification turn into. Null for `origin='user'`. |
| `dispatchGroupId` | shared by every sub-agent task spawned from one `spawn_sub_agent` call, so completions can count still-pending siblings. Null for `origin='user'`. |
| `role` | the sub-agent role name (`researcher`, etc.) — resolves to a fixed provider/model + tool list from config. Never sent to or chosen by the calling LLM. |

`origin: 'agent'` rows are excluded from the per-scope "one in-progress task" check added by the task-queue-serialization design — see that design's §1 (scope key). They can still carry a `workspaceId` (for read-only workspace context) without contending for that workspace's mutation slot.

### 3. Role configuration and tool restriction

A new config section maps a role name to `{ provider, model, systemPrompt }`; its exact schema shape is an implementation-planning detail and doesn't change this design's behavior contract, so it isn't specified further here. At dispatch time, `spawn_sub_agent`'s implementation resolves the role → provider/model — the tool's input schema exposes only `{ role: string, goal: string }`, no provider/model field, so the calling model has no path to influence infra selection.

The agent built for a sub-agent run (`buildTaskAgent`'s sub-agent branch, or a new sibling) gets an explicit allowlist of read-only built-in tools (e.g. file read, search, web search) rather than the parent's full tool set filtered down — an allowlist can't accidentally admit a new mutating tool added to the parent's set later; a denylist can. This allowlist excludes every mutating tool by construction, excludes all MCP tools (`loadMcpTools()` is not called for a sub-agent build at all — not filtered after the fact, never invoked), and excludes `spawn_sub_agent` itself. The exact tool names to include are an implementation-planning detail (enumerate against `api/src/agents/tools/*.tool.ts`), not specified further here. The exclusion is structural (a narrower list passed to `createAgent()`), not a runtime "am I nested" check — a sub-agent's agent literally cannot see a tool that would let it recurse or mutate.

### 4. Dispatch (`spawn_sub_agent` tool)

Fast, non-blocking, called from within the parent's current turn:

1. Validate `role` exists in config; resolve fixed provider/model/tools.
2. Generate one fresh `dispatchGroupId` for this call (shared across all N sub-agents it spawns, if N > 1).
3. For each requested sub-agent, insert a `tasks` row: `origin: 'agent'`, `parentThreadId: <calling thread>`, `dispatchGroupId`, `role`, `threadId: null` (minted lazily on first run, same as existing global-task behavior), then `enqueueTask()`.
4. Return immediately: `{ dispatched: [{ id, role }, ...] }`. The parent's current turn continues and completes normally — this tool never awaits the sub-agent's execution.
5. `getTaskScheduler().wake()` — same as every other route that enqueues work (`tasks.route.ts`, `workspace-chat.route.ts:155`).

From here, dispatch/execution/completion runs through the existing `TaskScheduler`/`executeTask()` pipeline unchanged, now able to run concurrently with other scopes' tasks per the task-queue-serialization design, and gated per-LLM-call by the target provider's queue per the provider-concurrency design.

### 5. Completion → notification turn on the parent thread

`executeTask()` finishing an `origin: 'agent'` row (done/failed/cancelled) triggers, instead of (in addition to) the normal `completeQueueEntry()` bookkeeping:

1. Query sibling rows sharing `dispatchGroupId` still in a non-terminal `task_queue` status → `remainingCount`.
2. Build a message for the parent thread: the sub-agent's result (or, on failure, an error summary — a failure still counts as a completion, so the parent is never left waiting on a dead sub-agent) plus `remainingCount`.
3. Attempt to claim `parentThreadId`'s turn slot via the existing `active-sse-writer.ts` mutex. If free, run the notification turn immediately. If held (the parent thread is mid-response to something else), push onto a new **per-thread pending-notification FIFO** (new module, e.g. `pending-thread-turns.ts`) instead of rejecting — there's no human to retry a system-generated delivery. Drained the same shape as the provider queue: on mutex release, pop the next pending notification (if any) and dispatch it as a new turn.

This intentionally delivers **one turn per completion**, not a batched turn combining multiple simultaneous completions — confirmed preference. `remainingCount` is what lets the parent agent know whether to keep waiting on siblings or treat this as the final piece.

### 6. Transcript status marker (the "interrupt" UX)

Extend the existing `recordTaskRunMarker()` (`task-execution.ts`, currently writes a `task_run_marker` message into the *running* task's own thread) to also write into `parentThreadId` for `origin: 'agent'` runs:

- On dispatch: "Sub-agent [role] started."
- On each completion: "Sub-agent [role] finished — N still running" or "— all done," carrying the same `remainingCount` from §5.

This is a transcript marker, not a graph-level pause — the parent thread's checkpoint is never blocked while a sub-agent runs (confirmed: dispatch is fire-and-forget, the user can keep chatting freely in the meantime).

### 7. Crash recovery

`recoverRunningQueueEntries()` (`workspace-store.ts:486`) needs one `origin`-aware branch: today, exhausting `MAX_QUEUE_RECOVERY_ATTEMPTS` escalates the task to `waiting_on_user`/`assigned_to: 'user'` — meaningless for a sub-agent, which has no human resolving it via the `/hitl` route. For `origin: 'agent'` rows, exhausting retries should instead: mark the row `failed`, and run the §5 completion-notification flow with a failure payload (still decrementing `remainingCount` for its siblings) rather than escalating to a user-facing HITL state.

---

## Error Handling & Edge Cases

- **Parent thread deleted before a sub-agent finishes:** notification delivery becomes a no-op — log it, mark the task row's delivery failed rather than throwing. Does not retry indefinitely.
- **Sub-agent errors mid-run (tool error, recursion limit):** same three-way branch `executeTask()` already has for ordinary tasks (`complete_task` called / `ask_user` interrupt / neither) — `ask_user` is not in a sub-agent's tool list (read-only, no HITL), so realistically only "explicit completion" or "ran out of steps" apply; both are `failed`-flavored completions that still fire §5.
- **All N sub-agents in a dispatch group fail:** each still delivers its own turn with a decrementing `remainingCount`; the parent sees N failure turns, same as it would see N success turns — no special batching of failure vs. success.

---

## Testing

- `spawn-sub-agent.tool.test.ts` (new): dispatching returns immediately without awaiting execution; N sub-agents share one `dispatchGroupId`; role validation rejects an unknown role.
- Agent-construction test: a sub-agent's tool list excludes `spawn_sub_agent`, all MCP tools, and every mutating built-in tool — assert by inspecting the constructed tool list, not by attempting a call.
- `task-execution.test.ts` (extended): an `origin: 'agent'` completion computes `remainingCount` correctly against sibling rows in various non-terminal states; a failure still decrements `remainingCount`.
- New notification-delivery test: parent thread mutex held → notification queues in the pending-notification FIFO → delivered once the mutex releases, not dropped or retried against a live connection.
- Crash-recovery test: an `origin: 'agent'` row stuck at `running` past `MAX_QUEUE_RECOVERY_ATTEMPTS` ends as `failed` with a delivered notification, not `waiting_on_user`.

## Evaluations

Once the role-based system prompt and tool restriction exist, worth an eval checking the model reliably uses `spawn_sub_agent` for delegatable subtasks rather than trying to do everything inline — deferred until real usage data exists, same reasoning as the automated-task-execution design's evaluation note.
