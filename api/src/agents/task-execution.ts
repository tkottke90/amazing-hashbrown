import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import { env } from '../config/env.js';
import { getThreadStore } from '../services/thread-store.js';
import {
  getWorkspaceStore,
  type Task,
  type TaskQueueEntry,
  type Workspace,
} from '../services/workspace-store.js';
import {
  setActiveSseWriter,
  clearActiveSseWriter,
  getActiveSseWriter,
  type SseWriter,
} from './active-sse-writer.js';
import { registerTaskAbort, getTaskAbort, clearTaskAbort } from './active-task-abort.js';
import {
  pipeEvents,
  finalizeTurn,
  recoverThrownInterrupt,
  drainAndRecordWikiUpdates,
  extractPartialAssistantState,
} from './stream-handler.js';
import { classifyChatError } from './error-classification.js';
import { buildTaskAgent, type WorkspaceChatContext, type ChatAgent } from './chat-agent.js';
import { getProviderQueue } from '../services/provider-queue.js';
import { buildWorkspaceContext, resolveAllowedWikiId } from './workspace-chat-stream-handler.js';
import {
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  recordTaskRunMarker,
} from './thread-message-writer.js';
import { deliverSubAgentCompletion } from './sub-agent-notification.js';
import type { CompleteTaskCall } from './tools/complete-task.tool.js';
import { drainPendingTurns, runOnceThreadFree } from './pending-thread-turns.js';
import { broadcast } from '../services/broadcast.js';

export type QueueEntryWithTask = TaskQueueEntry & { task: Task };

interface WorkspaceScope {
  workspace: Workspace;
  workspaceContext: WorkspaceChatContext;
  allowedWikiId?: string;
}

function buildKickoffMessage(task: Task, entry: QueueEntryWithTask): string {
  if (entry.pausedAt) {
    return `Resume this task — continue from where you left off: ${task.title}.`;
  }
  return `Begin work on this task now: ${task.title}.`;
}

export interface ExecuteTaskDeps {
  // Test-only seam — buildTaskAgent() calls the real createProvider()/
  // createAgent() machinery, which a unit test driving a fake event stream
  // cannot exercise directly. Defaults to the real implementation.
  buildTaskAgent?: typeof buildTaskAgent;
}

// Runs one automated task to completion (or to a waiting_on_user pause).
// Called by the scheduler as its TaskExecutor — see task-scheduler.ts. Never
// throws: every failure path ends the task queue entry as 'failed' rather
// than propagating, so a bug here can never wedge tick()/wake().
export async function executeTask(
  entry: QueueEntryWithTask,
  deps: ExecuteTaskDeps = {},
): Promise<void> {
  const buildAgent = deps.buildTaskAgent ?? buildTaskAgent;
  const { task } = entry;
  const store = getWorkspaceStore();
  const threadStore = getThreadStore();

  // Registered as early as possible so a Cancel/Pause/Take-over click can
  // never land before there's anything to abort — see active-task-abort.ts.
  const controller = registerTaskAbort(entry.id);

  let threadId: string;
  let workspaceScope: WorkspaceScope | undefined;

  try {
    if (task.workspaceId) {
      const workspace = store.getWorkspace(task.workspaceId);
      if (!workspace) {
        throw new Error(`Task ${task.id} references missing workspace ${task.workspaceId}`);
      }
      threadId = workspace.threadId ?? randomUUID();
      if (!workspace.threadId) {
        store.patchWorkspace(workspace.id, { threadId });
        threadStore.upsertThreadOnFirstMessage(threadId, workspace.name, 'workspace-chat');
      }
      const allowedWikiId = resolveAllowedWikiId(store, workspace.id);
      const workspaceContext = await buildWorkspaceContext(workspace);
      workspaceScope = { workspace, workspaceContext, allowedWikiId };
    } else {
      // A global task has no shared chat surface to inline into — it gets
      // its own dedicated 'task' thread, minted lazily on first run.
      threadId = task.threadId ?? randomUUID();
      if (!task.threadId) {
        store.patchTask(task.id, { threadId });
        threadStore.upsertThreadOnFirstMessage(threadId, task.title, 'task');
      }
    }
  } catch (err) {
    logger.error('task-execution: thread resolution failed', {
      taskId: task.id,
      err: serializeError(err),
    });
    store.completeQueueEntry(entry.id, 'failed');
    if (task.origin === 'agent') {
      await deliverSubAgentCompletion(task, 'failed', 'Failed to resolve an execution thread.');
    }
    clearTaskAbort(entry.id);
    return;
  }

  // Everything below claims threadId's per-thread mutex (active-sse-writer.ts)
  // and actually streams — wrapped in a closure and run via
  // runOnceThreadFree() rather than inline, so a thread that's already busy
  // (a live interactive turn still streaming, or another task/sub-agent-task
  // already running in this same workspace — dequeueNext()'s scope guard
  // excludes origin='agent' rows, so that case is real) defers instead of
  // racing a second concurrent agent.streamEvents() call against the same
  // LangGraph checkpoint thread_id, which can lose a parked interrupt. See
  // this function's own module-level doc and pending-thread-turns.ts.
  const runClaimed = async (): Promise<void> => {
    // Diagnostic for the "task shows running but nothing ever happens" class
    // of bug: this is the one line that proves runOnceThreadFree() actually
    // invoked this closure, as opposed to it still sitting queued in
    // pending-thread-turns.ts waiting for a drainPendingTurns() that never
    // comes. Cheap enough to leave in permanently.
    logger.info('task-execution: claimed thread, starting run', { taskId: task.id, threadId });

    // No live SSE connection drives this run (the scheduler invoked it, not
    // an HTTP request) — this sink only matters as (a) the concurrency mutex
    // workspace-chat-stream-handler.ts checks via getActiveSseWriter, and (b)
    // a forwarding shim for the rare case a client is already watching this
    // exact thread's own active writer slot (there isn't a general broadcast
    // mechanism today — see the design doc's scope note). By construction,
    // runOnceThreadFree() only ever invokes this closure once the thread is
    // confirmed free, so previousWriter should always read undefined here —
    // kept as a harmless defensive no-op rather than removed.
    // Captured before we claim the slot below — looking this up dynamically
    // inside the closure would return `sink` itself once registered, causing
    // unbounded self-recursion on every event.
    const previousWriter = getActiveSseWriter(threadId);
    const sink: SseWriter = (event) => {
      previousWriter?.(event);
    };
    setActiveSseWriter(threadId, sink);

    let finalOutcome: 'done' | 'failed' | 'waiting_on_user' | 'cancelled' | 'blocked' = 'failed';
    // Hoisted above the try block (rather than declared inside it) so the
    // catch block below can still reach them to clean up a mid-stream failure
    // — mirroring failAssistant's role in the interactive chat/workspace-chat
    // handlers (marks the streaming row 'error' and sweeps any tool_call rows
    // this turn left 'pending' to 'interrupted').
    let msgId: string | undefined;
    let turnSentAt: string | undefined;
    // Also hoisted (see above) — needed by the catch block's GraphInterrupt
    // branch to re-query checkpoint state and re-dispatch a HITL prompt after
    // a mid-stream throw, the same way the graceful (non-throwing) path does.
    let agent: ChatAgent | undefined;
    let config: { configurable: { thread_id: string; workspaceId?: string } } | undefined;
    // number | null (not | undefined) to match recordAssistantStart's return
    // type and finalizeTurn/dispatchHitlPrompt's own assistantSeq param type.
    let assistantSeq: number | null = null;

    try {
      recordTaskRunMarker(threadStore, threadId, randomUUID(), task.id, task.title, 'start');
      // Fires for every run that actually starts, including one that
      // immediately pauses (blocked) or aborts mid-stream — distinct from
      // the dependency-blocked pending -> blocked transition, which never
      // reaches executeTask() at all and so never fires this.
      broadcast({ type: 'task_started', threadId, taskId: task.id });
      drainAndRecordWikiUpdates(sink, threadStore, threadId);

      // Filled only by an *accepted* complete_task call — the tool itself
      // decides acceptance (it rejects the first "done" while plan steps are
      // unchecked; see complete-task.tool.ts) and reports it through
      // onTaskComplete. A boxed value rather than a bare `let` — TS's
      // control-flow narrowing can't see the reassignment happening inside
      // the callback, so a bare variable would narrow to `null` at the check
      // below. Last accepted call wins.
      const completeTaskBox: { current: CompleteTaskCall | null } = { current: null };

      agent = (
        await buildAgent(
          task,
          undefined,
          undefined,
          workspaceScope
            ? {
                workspaceContext: workspaceScope.workspaceContext,
                allowedWikiId: workspaceScope.allowedWikiId,
              }
            : undefined,
          {
            onTaskComplete: (call) => {
              completeTaskBox.current = call;
            },
          },
        )
      ).agent;

      config = {
        configurable: {
          thread_id: threadId,
          ...(workspaceScope ? { workspaceId: workspaceScope.workspace.id } : {}),
        },
      };
      msgId = randomUUID();
      turnSentAt = new Date().toISOString();
      const startedAt = Date.now();
      assistantSeq = recordAssistantStart(threadStore, threadId, msgId, turnSentAt);

      // A resume_answer set by the /hitl route's task re-enqueue branch means
      // this run continues a previously-interrupted checkpoint — consumed
      // (cleared) here so a later re-enqueue for a *different* pause doesn't
      // accidentally replay a stale answer.
      const resumeAnswer = task.resumeAnswer;
      if (resumeAnswer) {
        store.patchTask(task.id, { resumeAnswer: null });
      }
      const input = resumeAnswer
        ? new Command({ resume: resumeAnswer })
        : { messages: [{ role: 'human', content: buildKickoffMessage(task, entry) }] };

      // Local consts — msgId/turnSentAt/agent/config are outer `let`s just
      // assigned above, but TS can't carry that narrowing into an async
      // closure passed to withSlot() (it could in principle run after a later
      // reassignment), so it widens them back to their unnarrowed types inside
      // the closure.
      const resolvedMsgId = msgId;
      const resolvedTurnSentAt = turnSentAt;
      const resolvedAgent = agent;
      const resolvedConfig = config;

      const { content, thoughtContent, finalSegmentId, hadToolCall } =
        await getProviderQueue().withSlot(
          env.defaultProvider,
          'async',
          async () => {
            const rawStream = resolvedAgent.streamEvents(input, {
              ...resolvedConfig,
              version: 'v2',
              recursionLimit: env.agent?.recursionLimit ?? 100,
              signal: controller.signal,
              context: {
                provider: env.defaultProvider,
                model: undefined,
                afterAgentEnabled: undefined,
              },
            });
            return pipeEvents(
              sink,
              resolvedMsgId,
              rawStream,
              threadStore,
              threadId,
              resolvedTurnSentAt,
            );
          },
          { signal: controller.signal },
        );
      const { interrupted } = await finalizeTurn(
        sink,
        threadStore,
        agent,
        threadId,
        finalSegmentId,
        startedAt,
        content,
        thoughtContent,
        hadToolCall,
        turnSentAt,
        assistantSeq,
        null,
        undefined,
        // Task runs always use the default provider (see this file's own
        // agent.streamEvents context above) — passing it through here is what
        // lets finalizeTurn's Ollama empty-response check apply to task runs
        // too, not just interactive chat turns.
        env.defaultProvider,
        undefined,
        task.id,
        // completeTaskBox is already populated by now — complete_task's tool
        // body (which fires onTaskComplete) runs inside the stream that
        // pipeEvents fully drained before this call, above. When it's set, this run's own outcome is already
        // decided; a pending interrupt finalizeTurn finds in the shared
        // thread's checkpoint state past this point is not this run's to
        // dispatch as a live prompt — see finalizeTurn's own comment on
        // discardInterrupt.
        Boolean(completeTaskBox.current),
      );

      if (completeTaskBox.current) {
        finalOutcome = completeTaskBox.current.outcome;
        store.completeQueueEntry(entry.id, completeTaskBox.current.outcome);
        if (task.origin === 'agent') {
          await deliverSubAgentCompletion(
            task,
            completeTaskBox.current.outcome,
            completeTaskBox.current.summary,
          );
        }
      } else if (interrupted) {
        // Unreachable for origin='agent' rows in practice — a sub-agent's
        // tool list never includes ask_user (see buildSubAgentAgent), so it
        // has no way to trigger a LangGraph interrupt(). Left as ordinary
        // task behavior rather than special-cased, since there is no
        // sub-agent-flavored notion of "waiting" to deliver a notification
        // about.
        finalOutcome = 'waiting_on_user';
        // Parks the queue row rather than closing it out — see
        // parkQueueEntryForHitl()'s own comment: keeping the row alive at
        // its original queue position is what lets the eventual resume
        // (workspace-chat.route.ts's /hitl task branch) avoid the
        // queue-position starvation a fresh enqueueTask() call would cause.
        store.parkQueueEntryForHitl(entry.id);
      } else {
        // The agent stopped without calling complete_task or ask_user — e.g.
        // it trailed off, or hit GraphRecursionError inside pipeEvents/
        // finalizeTurn. This is exactly the bug #87 exists to fix: never leave
        // the task stuck in 'running'.
        finalOutcome = 'failed';
        store.completeQueueEntry(entry.id, 'failed');
        if (task.origin === 'agent') {
          await deliverSubAgentCompletion(
            task,
            'failed',
            'Stopped without completing the task (ran out of steps or produced no final action).',
          );
        }
      }
    } catch (err) {
      // Distinguish "this catch fired because a Cancel/Pause/Take-over
      // aborted the stream" from a genuine failure by checking the abort
      // registry's own signal, not by string-matching err.name (there's no
      // reliable precedent in this codebase for what @langchain/core throws
      // on abort).
      const abortEntry = getTaskAbort(entry.id);
      const wasAborted = abortEntry?.controller.signal.aborted ?? false;
      const intent = wasAborted ? abortEntry?.intent : null;

      // Recovers the segment id/partial content pipeEvents was mid-way through
      // when it threw (see stream-handler.ts's PipeEventsError), used by both
      // the genuine-failure and aborted-run branches below.
      const partialState =
        msgId !== undefined ? extractPartialAssistantState(err, msgId) : undefined;

      // Shared terminal bookkeeping for "this run ends in a real failure" —
      // used by the generic catch-all AND the GraphInterrupt branch's own
      // safety-net fallback, so neither leaves the queue entry stuck.
      const finishFailedRun = async (notifyMessage: string): Promise<void> => {
        finalOutcome = 'failed';
        store.completeQueueEntry(entry.id, 'failed');
        if (task.origin === 'agent') {
          await deliverSubAgentCompletion(task, 'failed', notifyMessage);
        }
      };

      if (intent === 'cancel') {
        logger.info('task-execution: run cancelled', { taskId: task.id });
        finalOutcome = 'cancelled';
        store.completeQueueEntry(entry.id, 'cancelled');
        // A cancelled sub-agent still counts as a completion for its siblings'
        // remainingCount — nothing else would ever clear it (design's Out-of-
        // scope note only says there's no new *cancellation UX*, not that a
        // cancelled origin='agent' row skips notification entirely).
        if (task.origin === 'agent') {
          await deliverSubAgentCompletion(task, 'cancelled');
        }
      } else if (intent === 'pause') {
        logger.info('task-execution: run paused', { taskId: task.id });
        finalOutcome = 'blocked';
        store.parkQueueEntry(entry.id);
      } else if (intent === 'take-over') {
        logger.info('task-execution: run taken over', { taskId: task.id });
        finalOutcome = 'cancelled';
        store.detachQueueEntry(entry.id);
      } else if ((err as Error).name === 'GraphInterrupt') {
        // The graceful (non-throwing) path handles an interrupt by reading it
        // off state returned from pipeEvents/finalizeTurn — but LangGraph can
        // also raise it as a thrown GraphInterrupt mid-stream, which pipeEvents
        // forwards as a PipeEventsError preserving `.name` (see
        // stream-handler.ts). recoverThrownInterrupt recovers the same way
        // every other turn handler (chat, workspace chat, wiki chat, headless
        // notifications) does — see that function's own comment.
        logger.info('task-execution: run interrupted (thrown GraphInterrupt)', { taskId: task.id });
        const recovered =
          partialState && turnSentAt !== undefined && agent && config
            ? await recoverThrownInterrupt(
                err,
                sink,
                threadStore,
                agent,
                config,
                threadId,
                partialState.segmentId,
                turnSentAt,
                assistantSeq,
                null,
                task.id,
              )
            : null;
        if (recovered?.interrupted) {
          finalOutcome = 'waiting_on_user';
          // Parks the row rather than closing it — see parkQueueEntryForHitl()'s
          // own comment (same reasoning as the graceful branch above).
          store.parkQueueEntryForHitl(entry.id);
        } else {
          // recovered === {interrupted: false} means recoverThrownInterrupt's
          // own failAssistant/dispatchHitlPrompt already marked the row
          // 'error' — recovered === null means the guard above never ran it.
          // Either way, the queue entry still needs closing out.
          await finishFailedRun('Failed to record the approval prompt.');
        }
      } else {
        logger.error('task-execution: run failed', { taskId: task.id, err: serializeError(err) });
        finalOutcome = 'failed';
        if (partialState && turnSentAt !== undefined) {
          if ((err as Error).name === 'GraphRecursionError') {
            finalizeAssistant(
              threadStore,
              threadId,
              partialState.segmentId,
              'Ran out of steps before completing this task.',
              '',
              turnSentAt,
              null,
            );
          } else {
            const classified = classifyChatError(err, env.defaultProvider);
            failAssistant(
              threadStore,
              threadId,
              partialState.segmentId,
              partialState.content,
              turnSentAt,
              partialState.thoughtContent,
              classified.message,
              classified.category,
            );
          }
        }
        await finishFailedRun((err as Error)?.message ?? 'Run failed.');
      }

      // For an aborted run (any of the three intents), the streaming
      // assistant row is still mid-turn — close it out the same way a
      // genuine failure does, or it stays stuck "in progress" in the thread
      // UI forever.
      if (intent && partialState && turnSentAt !== undefined) {
        failAssistant(
          threadStore,
          threadId,
          partialState.segmentId,
          partialState.content,
          turnSentAt,
          partialState.thoughtContent,
        );
      }
    } finally {
      recordTaskRunMarker(
        threadStore,
        threadId,
        randomUUID(),
        task.id,
        task.title,
        'end',
        finalOutcome,
      );
      // Single choke point for the live-events broadcast (see
      // docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md) —
      // finalOutcome is already assigned by every branch above (both the
      // graceful try-block outcomes and all five catch-block cases), so this
      // covers every run without touching any of those branches themselves.
      // 'blocked' (a user-initiated pause, not a HITL wait) deliberately
      // broadcasts neither event: the task_queue_update from wake() already
      // reflects it, and there's no thread-side content to react to.
      if (finalOutcome === 'waiting_on_user') {
        broadcast({ type: 'hitl_prompt', threadId, taskId: task.id });
      } else if (
        finalOutcome === 'done' ||
        finalOutcome === 'failed' ||
        finalOutcome === 'cancelled'
      ) {
        broadcast({ type: 'task_completed', threadId, taskId: task.id, outcome: finalOutcome });
      }
      clearActiveSseWriter(threadId);
      drainPendingTurns(threadId);
      clearTaskAbort(entry.id);
    }
  };

  await runOnceThreadFree(threadId, runClaimed);
}
