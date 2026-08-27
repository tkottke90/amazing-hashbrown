# Automated Task Execution — Wire Agent Work Into the Scheduler — Design

**Date:** 2026-08-27
**Status:** Draft
**Related:** [Issue #87](https://github.com/tkottke90/amazing-hashbrown/issues/87)

---

## Goal

When the scheduler dequeues a `ready` agent-assigned task, actually run an agent against it — reading/writing the wiki in a loop until the task's outcome is met — instead of leaving it parked in `running` forever, which is what happens today.

---

## Problem

`task-scheduler.ts`'s `tick()` dequeues a task, marks it `running`, and stops — the TODO comment says plainly that agent invocation isn't wired up yet. Nothing ever calls `completeQueueEntry()`, so any task that reaches `running` sits there permanently. Its real dependencies (wiki orient/write/lint tools, web/URL ingestion, RLM, and — since this design was scoped — the project write-restriction guardrail in `#79`) are already complete, so the only missing piece is the wiring itself.

---

## Scope

**In scope:**

- Workspace-scoped tasks, including project-scoped tasks (writes restricted to the project's ephemeral wiki via the existing `#79` guardrail)
- Global tasks (no `workspaceId`), via the same unrestricted agent the main chat route uses
- Visible execution: task runs appear as turns in the workspace's existing persistent chat thread, bracketed by a marker so the user can tell task activity apart from their own chat
- Clean completion via a dedicated `complete_task` tool, and a `waiting_on_user` path that reuses the existing `ask_user` HITL/interrupt mechanism
- A concurrency guard so a task run and a live chat turn never write to the same thread's LangGraph checkpoint concurrently

**Out of scope (deferred to other issues/known gaps):**

- Cancel/abort of a running task (`#86`) — reassignment-while-running and true mid-flight interruption are explicitly that issue's problem
- Cron-triggered enqueueing (`#72`) — this issue only wires up what happens once a task is already dequeued, not new ways to enqueue one
- Live SSE push to a browser tab sitting idle on a workspace's Chat tab while a task runs unattended — `registerQueueBroadcast()` has no caller today (confirmed dead code, already flagged as a pre-existing gap by the `#80` webhook-trigger design doc); this issue persists everything durably but doesn't add general broadcast infrastructure
- Workspace deletion/archival mid-run — left for `#78` (project close) to reckon with, same as any other in-flight work at close time

---

## Design

### 1. Scheduler dispatch

`TaskScheduler.tick()` (`api/src/services/task-scheduler.ts`) stays synchronous. Once `dequeueNext()` returns a `running` entry, `tick()` calls a new `executeTask(entry)` as fire-and-forget:

```ts
private tick(): void {
  const store = getWorkspaceStore();
  if (store.getRunningEntry()) return;

  const next = store.dequeueNext();
  if (!next) return;

  logger.info('Task scheduler: starting task', { taskId: next.taskId, queueId: next.id });
  void this.executeTask(next).catch((err: unknown) => {
    logger.error('Task scheduler: executeTask failed unexpectedly', { taskId: next.taskId, err: String(err) });
  });
}
```

`executeTask()` itself catches everything internally (see Error Handling) — the `.catch()` above is a last-resort backstop, not the primary error path, so a bug in `executeTask()` can never surface as an unhandled rejection or break `tick()`/`wake()`.

### 2. Thread resolution

- **Workspace-scoped task:** reuse `workspace.threadId`. If null (workspace never chatted in), mint one (`randomUUID()`) and persist it via `getWorkspaceStore().patchWorkspace(workspaceId, { threadId })` — the same operation the frontend performs on first visit to the Chat tab (`workspace-chat-tab.tsx`), just triggered server-side.
- **Global task (no `workspaceId`):** there's no existing shared chat surface to inline into (multi-conversation support for the main chat route isn't built yet). New nullable `tasks.thread_id` column, minted lazily on the task's own first automated run — the task gets one dedicated thread containing only its own turns.

New migration appended to `workspace-store.ts`'s migration list:

```sql
ALTER TABLE tasks ADD COLUMN thread_id TEXT;
```

No `REFERENCES threads(id)` — same reasoning as `workspaces.thread_id` (`#75`): `WorkspaceStore` is frequently constructed standalone in tests against a database with no `threads` table.

### 3. Agent construction

New `buildTaskAgent()` in `chat-agent.ts`, built fresh per run (not cached like `getChatAgent`/`getWorkspaceChatAgent`, since its tools and prompt are specific to one task):

- **Workspace-scoped:** same tool set as `buildWorkspaceChatAgent` — `STATIC_CHAT_TOOLS` + `buildGatedTools()` + `buildWikiWriteTools(allowedWikiId)` (via the existing `resolveAllowedWikiId(store, workspaceId)`, so project tasks inherit the `#79` write guardrail automatically) + MCP tools.
- **Global:** same tool set as `buildChatAgent` — `buildWikiWriteTools()` unrestricted.
- Both add one new tool: `makeCompleteTaskTool(taskId)` (see §5), built fresh per run and closed over that specific task's id — never present in interactive chat/workspace-chat agents.
- System prompt: `buildSystemPrompt(getAgentInstructions(), taskContextBlock)`, where `taskContextBlock` is a new function parallel to `buildWorkspaceContextBlock`, stating the task's title/description/outcome as this run's goal and instructing the model to call `complete_task` when done or unable to proceed, or `ask_user` if it needs input.

### 4. Streaming reuse

`stream-handler.ts`'s `writeSseEvent`, `flushDelta`, `drainBuffer`, `pipeEvents`, and `finalizeTurn` change their first parameter's type from `Response` to the `SseWriter` function type already defined in `active-sse-writer.ts` (`(event: ChatSSEEvent) => void`) — a type rename plus replacing `res.write(...)` with a direct call to the sink, not a new abstraction:

```ts
export function writeSseEvent(sink: SseWriter, event: ChatSSEEvent): void {
  sink(event);
}
```

The 3 existing HTTP call sites (`chat.route.ts`, `workspace-chat.route.ts`, `wiki.route.ts` — wherever `pipeEvents`/`finalizeTurn`/`writeSseEvent` are currently called with `res`) wrap it once: `(event) => res.write(\`data: ${JSON.stringify(event)}\n\n\`)`. Persistence calls inside `pipeEvents` (`recordToolCallStart`, `finalizeAssistant`, etc.) already take `threadStore`/`threadId` directly and don't go through the sink — task runs are durably recorded regardless of whether anything is listening live.

New `api/src/agents/task-execution.ts` (sibling to `workspace-chat-stream-handler.ts`) hosts `executeTask()`. Its sink:

```ts
const sink: SseWriter = (event) => { getActiveSseWriter(threadId)?.(event); };
```

— a no-op unless a live chat turn's SSE writer happens to already occupy that slot, which (per §6) it never will while a task is running.

### 5. `complete_task` tool

New `api/src/agents/tools/complete-task.tool.ts`:

```ts
export function makeCompleteTaskTool(taskId: string) {
  return tool(
    async ({ outcome, summary }: { outcome: 'done' | 'failed'; summary: string }) => {
      return { taskId, outcome, summary };
    },
    {
      name: 'complete_task',
      description: 'Call this when the task\'s outcome has been met, or when you cannot proceed further. This ends the automated run.',
      schema: CompleteTaskSchema, // { outcome: enum('done','failed'), summary: string }
    },
  );
}
```

The tool's return value doesn't drive completion directly (LangChain tools can't halt the graph from inside); `executeTask()` detects the call by inspecting `on_tool_start`/`on_tool_end` events for `name === 'complete_task'` during `pipeEvents`, the same mechanism `pipeEvents` already uses to special-case `ask_user`.

### 6. Task lifecycle after the run

`executeTask()` receives the queue entry from `dequeueNext()` (`entry.id` is the `task_queue` row id, `entry.taskId` the task's id — referred to below as `queueId`/`taskId`). It runs `agent.streamEvents(...)` through `pipeEvents`/`finalizeTurn` (mirroring `streamWorkspaceChatToSse`'s shape, minus the HTTP-specific pieces), then branches on what happened during the run:

| What happened during the run | Result |
| --- | --- |
| `complete_task` called with `outcome` | `completeQueueEntry(queueId, outcome)` — mirrors onto `tasks.status` as today |
| `ask_user` interrupted the graph (a `hitl_prompt` row was recorded `pending`) | `tasks.status = 'waiting_on_user'`, `assigned_to = 'user'`; `completeQueueEntry(queueId, 'done')` — the queue entry is done (off the scheduler's plate; `task_queue.status` has no `waiting_on_user` value), the *task* is not |
| Stream ended with neither (trailed off, or `GraphRecursionError`) | `completeQueueEntry(queueId, 'failed')` with a synthesized summary ("ran out of steps before completing" / "stopped without finishing or asking for help") — never left stuck in `running`, which is the exact bug this issue fixes |

`recordHitlPrompt`'s payload for a task-originated prompt includes `taskId` (payload is already free-form JSON — no schema change). The existing `/workspaces/:id/chat/:threadId/hitl` route, on resolving a prompt, checks for `payload.taskId`: if present, it re-enqueues the task (`tasks.status = 'ready'`, `assigned_to = 'agent'`, new `task_queue` row) instead of resuming as a plain chat turn. The scheduler's normal dequeue path picks it back up and resumes the *same* LangGraph checkpoint (same `thread_id`), continuing mid-goal with prior tool results intact. Routing through re-enqueue (rather than a second inline-resume code path) keeps the "one task runs at a time" invariant intact and reuses the scheduler's existing logging/broadcast/error handling instead of duplicating it.

After every branch above, `executeTask()` calls `this.wake()` to pick up the next queued item — matching the handoff the current TODO comment already describes.

### 7. Concurrency guard

`executeTask()` calls `setActiveSseWriter(threadId, sink)` for the run's duration and `clearActiveSseWriter(threadId)` in a `finally` — exactly what the three chat-turn functions already do, reusing that map as a mutex rather than only a broadcast registry.

`streamWorkspaceChatToSse` / `resumeWorkspaceChatToSse` / `retryWorkspaceChatToSse` (`workspace-chat-stream-handler.ts`) gain a check before building the agent: if `getActiveSseWriter(threadId)` is already set, reject with a `stream_error` event ("this workspace has a task running — try again in a moment") instead of starting a second `agent.streamEvents()` call against the same thread. This is a wait/reject, not a cancel — interrupting an in-flight task is `#86`'s job.

### 8. Task-origin marker in the shared thread

New message `kind: 'task_run_marker'` (payload: `{ taskId, taskTitle, phase: 'start' | 'end', outcome? }`), written via a new `recordTaskRunMarker()` in `thread-message-writer.ts` — one at the start of `executeTask()`'s run, one at the end. Mirrors the existing `resource_card`/`wiki_update` pattern of extending the free-form `payload` column rather than adding new columns. Frontend needs one new `case` in its message-kind switch to render a divider/banner; no further visual design is in scope for this issue.

---

## Error Handling & Edge Cases

- **Uncaught exception during `executeTask()`:** caught internally, logged, `completeQueueEntry(queueId, 'failed')` with the error message as the summary. Never propagates to `tick()`/`wake()`.
- **Process restart mid-run:** unchanged — the existing `recoverStuckEntries()` crash-recovery path (retry up to `MAX_QUEUE_RECOVERY_ATTEMPTS`, then escalate to `waiting_on_user`) already handles a `task_queue` row stuck at `running`; this issue is what finally makes that path meaningful, since tasks can now actually be running for real.
- **Task reassigned away from `agent` while running:** explicitly `#86`'s problem per its own issue text; this issue doesn't add handling for it and doesn't make it worse.
- **Step limits:** no new cap. The existing `recursionLimit` middleware (`env.agent?.recursionLimit ?? 100`) already bounds a single graph invocation. `TODO_LIST.md`'s note about a "configurable cap on simultaneously running tasks" is already satisfied trivially — the scheduler only ever runs one `task_queue` entry at a time (`getRunningEntry()` guard) — and this design doesn't change that.

---

## Testing

- **`task-scheduler.test.ts`** (extended): `tick()` dispatches `executeTask()` exactly once per dequeue; a rejected `executeTask()` doesn't prevent the next tick from processing.
- **New `task-execution.test.ts`**: the three outcome branches in §6 (`complete_task` → matching `completeQueueEntry` outcome; `ask_user` interrupt → `waiting_on_user` + queue entry `done`; neither → `failed` with synthesized summary). Uses the same fake-event-stream harness style as `stream-handler.test.ts`'s existing `pipeEvents` tests.
- **`stream-handler.test.ts`** (extended): the `Response` → `SseWriter` rename doesn't change existing chat-route behavior (the `res`-wrapping adapter is transparent).
- **Concurrency guard test:** starting a workspace-chat turn while `getActiveSseWriter(threadId)` is already set (simulating an in-flight task) asserts the `stream_error` rejection, not a second concurrent `streamEvents()` call.
- **Resume-from-HITL test:** resolving a prompt whose payload carries `taskId` re-enqueues the task rather than resuming as a plain chat turn.
- E2E: out of scope — no new user-facing UI beyond the thread marker banner; covered at the unit/integration level above.

## Evaluations

Not applicable — this issue is scheduler/agent-construction wiring, not new model-facing behavior beyond the task-context prompt block and the `complete_task`/`ask_user` tool choice already covered by existing eval patterns for tool selection. If eval gaps surface once the task-context prompt exists (e.g. whether the model reliably calls `complete_task` vs. trailing off), that's better scoped as a follow-up once real usage data exists, matching how `Agent Behavior Baseline` in `TODO_LIST.md` is already handled.
