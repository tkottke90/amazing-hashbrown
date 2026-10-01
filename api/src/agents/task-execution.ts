import { randomUUID } from 'node:crypto';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import { env, type ProviderConfig } from '../config/env.js';
import { getThreadStore, type ThreadStore } from '../services/thread-store.js';
import {
  getWorkspaceStore,
  type Task,
  type TaskQueueEntry,
  type TaskRun,
  type Workspace,
  type WorkspaceStore,
} from '../services/workspace-store.js';
import { setActiveSseWriter, getActiveSseWriter, type SseWriter } from './active-sse-writer.js';
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
import { resolveProviderConfig } from '../services/provider-factory.js';
import { buildWorkspaceContext } from './workspace-chat-stream-handler.js';
import {
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  recordTaskRunMarker,
  mirrorPendingTaskPrompts,
  type TaskRunMarkerRun,
} from './thread-message-writer.js';
import { buildRunKickoff, type PreviousRun } from './task-context.js';
import { deliverSubAgentCompletion } from './sub-agent-notification.js';
import {
  resolveTurnModel,
  startTurnObservability,
  type TurnObservability,
} from './turn-observability.js';
import type { CompleteTaskCall } from './tools/complete-task.tool.js';
import { endThreadTurn, runOnceThreadFree } from './pending-thread-turns.js';
import { broadcast } from '../services/broadcast.js';

export type QueueEntryWithTask = TaskQueueEntry & { task: Task };

interface WorkspaceScope {
  workspace: Workspace;
  workspaceContext: WorkspaceChatContext;
}

// Task runs always use the default provider. classifyChatError() needs its
// type, not its name — resolved inside a try because this runs on the failure
// path, where a misconfigured default provider must not throw a second time
// (the run itself resolves it through resolveTurnModel(), which does throw).
function defaultProviderType(): ProviderConfig['type'] | undefined {
  try {
    return resolveProviderConfig(env.defaultProvider).type;
  } catch {
    return undefined;
  }
}

const FINISHED_RUN: ReadonlySet<TaskRun['status']> = new Set(['done', 'failed', 'cancelled']);

// How far back run history looks for the previous runs a kickoff lists —
// the kickoff shows at most 4, this just leaves headroom for unfinished or
// transcript-less rows interleaved with them.
const RUN_HISTORY_WINDOW = 20;

// Finished earlier runs of this task that have a transcript to read, newest
// first — what the kickoff message lists and read_task_run can open.
function previousRunsOf(store: WorkspaceStore, entry: QueueEntryWithTask): PreviousRun[] {
  return store
    .listTaskRuns(entry.taskId, { limit: RUN_HISTORY_WINDOW })
    .filter((r) => r.id !== entry.id && FINISHED_RUN.has(r.status) && r.threadId !== null)
    .map((r) => ({
      id: r.id,
      runNumber: r.runNumber,
      status: r.status,
      startedAt: r.startedAt,
      summary: r.summary,
    }));
}

// The workspace's shared chat thread, where a workspace task's run markers
// are copied so the user sees task activity (and a link to the run) from
// the chat they already watch. Minted the same way the workspace chat tab
// would if the workspace has never been chatted in.
function ensureWorkspaceChatThread(
  store: WorkspaceStore,
  threadStore: ThreadStore,
  workspace: Workspace,
): string {
  if (workspace.threadId) return workspace.threadId;
  const threadId = randomUUID();
  store.patchWorkspace(workspace.id, { threadId });
  threadStore.upsertThreadOnFirstMessage(threadId, workspace.name, 'workspace-chat');
  return threadId;
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
  // The workspace chat thread a workspace task's run markers are copied
  // into — null for an Inbox task, which has no shared chat surface.
  let mirrorThreadId: string | null = null;
  // Every run executes in its own 'task' thread, minted on the run's first
  // start and stored on its queue row. A row that already has one is
  // continuing (a HITL answer, a user Resume, or a crash-recovery retry)
  // and must reuse it: its LangGraph checkpoint lives there. See
  // docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §3.
  const isNewRun = entry.threadId === null;
  const runNumber = store.getTaskRun(entry.id)?.runNumber ?? 1;

  try {
    if (task.workspaceId) {
      const workspace = store.getWorkspace(task.workspaceId);
      if (!workspace) {
        throw new Error(`Task ${task.id} references missing workspace ${task.workspaceId}`);
      }
      const workspaceContext = await buildWorkspaceContext(workspace);
      workspaceScope = { workspace, workspaceContext };
      mirrorThreadId = ensureWorkspaceChatThread(store, threadStore, workspace);
    }
    if (entry.threadId !== null) {
      threadId = entry.threadId;
    } else {
      threadId = randomUUID();
      threadStore.upsertThreadOnFirstMessage(threadId, `${task.title} — run #${runNumber}`, 'task');
      store.setQueueEntryThread(entry.id, threadId);
    }
  } catch (err) {
    logger.error('task-execution: thread resolution failed', {
      taskId: task.id,
      err: serializeError(err),
    });
    store.setQueueEntrySummary(entry.id, 'Failed to resolve an execution thread.');
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
  // defers instead of racing a second concurrent agent.streamEvents() call
  // against the same LangGraph checkpoint thread_id, which can lose a parked
  // interrupt. Since every run has its own thread, only a run continuing in
  // a thread that's still being written to (e.g. a sub-agent completion
  // notification landing in a waiting parent run) can hit this; it no
  // longer contends with the workspace chat. See pending-thread-turns.ts.
  // A new run starts from a clean slate: the plan's steps (the user's own
  // checklist) all go back to unchecked, and any stale resume answer is
  // dropped — it belonged to a checkpoint in an earlier run's thread. The
  // task's description and outcome (its standing instructions and goal) are
  // never touched.
  let runTask = task;
  if (isNewRun) {
    const resetPlan = task.plan?.some((s) => s.done)
      ? task.plan.map((s) => ({ ...s, done: false }))
      : undefined;
    if (resetPlan || task.resumeAnswer) {
      runTask =
        store.patchTask(task.id, {
          ...(resetPlan ? { plan: resetPlan } : {}),
          ...(task.resumeAnswer ? { resumeAnswer: null } : {}),
        }) ?? task;
    }
  }
  const previousRuns = previousRunsOf(store, entry);
  const markerRun: TaskRunMarkerRun = {
    runThreadId: threadId,
    runNumber,
    triggerSource: entry.triggerSource,
  };
  // Every marker/lifecycle event lands in the run's own thread, and is
  // copied to the workspace chat for a workspace task.
  const markerThreads = mirrorThreadId ? [threadId, mirrorThreadId] : [threadId];
  const recordMarker = (
    phase: 'start' | 'end',
    outcome?: 'done' | 'failed' | 'waiting_on_user' | 'cancelled' | 'blocked',
  ): void => {
    for (const target of markerThreads) {
      recordTaskRunMarker(
        threadStore,
        target,
        randomUUID(),
        task.id,
        task.title,
        phase,
        outcome,
        markerRun,
      );
    }
  };

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
    // This run's observability trace (#132), and the error it is closed
    // with — both hoisted so the finally block below can close it whichever
    // branch the run ends in.
    let turnObs: TurnObservability | undefined;
    let traceError: string | null = null;

    try {
      recordMarker('start');
      // Fires for every run that actually starts, including one that
      // immediately pauses (blocked) or aborts mid-stream — distinct from
      // the dependency-blocked pending -> blocked transition, which never
      // reaches executeTask() at all and so never fires this.
      for (const target of markerThreads) {
        broadcast({ type: 'task_started', threadId: target, taskId: task.id });
      }
      drainAndRecordWikiUpdates(sink, threadStore, threadId);

      // Filled only by an *accepted* complete_task call — the tool itself
      // decides acceptance (it rejects the first "done" while plan steps are
      // unchecked; see complete-task.tool.ts) and reports it through
      // onTaskComplete. A boxed value rather than a bare `let` — TS's
      // control-flow narrowing can't see the reassignment happening inside
      // the callback, so a bare variable would narrow to `null` at the check
      // below. Last accepted call wins.
      const completeTaskBox: { current: CompleteTaskCall | null } = { current: null };

      // Task runs always use the default provider, resolved to a concrete
      // model up front so the agent that runs, the trace, and the cost-rate
      // lookup in finalizeTurn all agree on it.
      const { provider, model } = resolveTurnModel(env.defaultProvider);

      const built = await buildAgent(
        runTask,
        provider,
        model,
        workspaceScope ? { workspaceContext: workspaceScope.workspaceContext } : undefined,
        {
          onTaskComplete: (call) => {
            completeTaskBox.current = call;
          },
        },
        { runId: entry.id, hasPreviousRun: previousRuns.length > 0 },
      );
      agent = built.agent;
      turnObs = startTurnObservability({
        threadId,
        taskId: task.id,
        provider,
        model,
        source: 'task-run',
        systemPrompt: built.systemPrompt,
      });

      config = {
        configurable: {
          thread_id: threadId,
          ...(workspaceScope ? { workspaceId: workspaceScope.workspace.id } : {}),
        },
      };
      msgId = randomUUID();
      turnSentAt = new Date().toISOString();
      const startedAt = Date.now();
      assistantSeq = recordAssistantStart(
        threadStore,
        threadId,
        msgId,
        turnSentAt,
        provider,
        model,
      );

      // A resume_answer set by the /hitl route's task re-enqueue branch means
      // this run continues a previously-interrupted checkpoint — consumed
      // (cleared) here so a later re-enqueue for a *different* pause doesn't
      // accidentally replay a stale answer.
      const resumeAnswer = runTask.resumeAnswer;
      if (resumeAnswer) {
        store.patchTask(task.id, { resumeAnswer: null });
      }
      const kickoff = buildRunKickoff({
        title: task.title,
        resume: entry.pausedAt !== null,
        runNumber,
        triggerSource: entry.triggerSource,
        scheduledFor: entry.scheduledFor,
        previousRuns,
      });
      const input = resumeAnswer
        ? new Command({ resume: resumeAnswer })
        : { messages: [{ role: 'human', content: kickoff }] };

      // Local consts — msgId/turnSentAt/agent/config are outer `let`s just
      // assigned above, but TS can't carry that narrowing into an async
      // closure passed to withSlot() (it could in principle run after a later
      // reassignment), so it widens them back to their unnarrowed types inside
      // the closure.
      const resolvedMsgId = msgId;
      const resolvedTurnSentAt = turnSentAt;
      const resolvedAgent = agent;
      const resolvedConfig = config;
      const resolvedTurnObs = turnObs;

      const { content, thoughtContent, finalSegmentId, hadToolCall } =
        await getProviderQueue().withSlot(
          provider,
          'async',
          async () => {
            const rawStream = resolvedAgent.streamEvents(
              input,
              resolvedTurnObs.attach({
                ...resolvedConfig,
                version: 'v2',
                recursionLimit: env.agent?.recursionLimit ?? 100,
                signal: controller.signal,
                context: {
                  provider,
                  model,
                  afterAgentEnabled: undefined,
                },
              }),
            );
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
        // The handler and resolved provider/model are what make finalizeTurn
        // compute, price and persist this turn's metrics (#132); the provider
        // also lets its Ollama empty-response check apply to task runs.
        turnObs.obsHandler,
        provider,
        model,
        task.id,
        // completeTaskBox is already populated by now — complete_task's tool
        // body (which fires onTaskComplete) runs inside the stream that
        // pipeEvents fully drained before this call, above (see
        // complete-task.tool.integration.test.ts). When it's set, this run's
        // own outcome is already decided; a pending interrupt finalizeTurn
        // finds in the shared thread's checkpoint state past this point is
        // not this run's to dispatch as a live prompt — see finalizeTurn's
        // own comment on discardInterrupt.
        Boolean(completeTaskBox.current),
      );

      if (completeTaskBox.current) {
        finalOutcome = completeTaskBox.current.outcome;
        store.setQueueEntrySummary(entry.id, completeTaskBox.current.summary);
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
        if (mirrorThreadId) mirrorPendingTaskPrompts(threadStore, threadId, mirrorThreadId);
      } else {
        // The agent stopped without calling complete_task or ask_user — e.g.
        // it trailed off, or hit GraphRecursionError inside pipeEvents/
        // finalizeTurn. This is exactly the bug #87 exists to fix: never leave
        // the task stuck in 'running'.
        finalOutcome = 'failed';
        const stoppedSummary =
          'Stopped without completing the task (ran out of steps or produced no final action).';
        store.setQueueEntrySummary(entry.id, stoppedSummary);
        store.completeQueueEntry(entry.id, 'failed');
        if (task.origin === 'agent') {
          await deliverSubAgentCompletion(task, 'failed', stoppedSummary);
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
      const finishFailedRun = async (
        notifyMessage: string,
        summary = notifyMessage,
      ): Promise<void> => {
        finalOutcome = 'failed';
        store.setQueueEntrySummary(entry.id, summary);
        store.completeQueueEntry(entry.id, 'failed');
        if (task.origin === 'agent') {
          await deliverSubAgentCompletion(task, 'failed', notifyMessage);
        }
      };

      // Same string interactive chat closes an aborted turn's trace with.
      if (intent) traceError = 'Stopped.';

      if (intent === 'cancel') {
        logger.info('task-execution: run cancelled', { taskId: task.id });
        finalOutcome = 'cancelled';
        store.setQueueEntrySummary(entry.id, 'Run cancelled by the user.');
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
        store.setQueueEntrySummary(entry.id, 'Run taken over by the user.');
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
          if (mirrorThreadId) mirrorPendingTaskPrompts(threadStore, threadId, mirrorThreadId);
        } else {
          // recovered === {interrupted: false, reason: ...} means
          // recoverThrownInterrupt's own failAssistant/dispatchHitlPrompt
          // already marked the row 'error' for a specific, known cause —
          // recovered === null means the hoisting guard above never even
          // ran it (effectively unreachable: agent/config/turnSentAt are
          // all assigned well before the stream starts). Either way, the
          // queue entry still needs closing out — but the two known causes
          // get their own message instead of one generic string covering
          // both, so the board card actually says what went wrong.
          const failureSummary =
            recovered?.reason === 'no_interrupt_in_state'
              ? 'Lost the approval prompt — the checkpoint had no pending interrupt right after the pause.'
              : recovered?.reason === 'persist_failed'
                ? `Could not save the approval prompt: ${recovered.detail ?? 'unknown database error'}`
                : 'Failed to record the approval prompt.';
          if (!recovered) {
            logger.error('task-execution: recoverThrownInterrupt guard never ran', {
              taskId: task.id,
            });
          }
          traceError = failureSummary;
          await finishFailedRun(failureSummary);
        }
        // A thrown GraphInterrupt that doesn't end in a real waiting_on_user
        // pause is always a bug, not an ordinary failure — the approval
        // prompt the user needed to answer is gone. One distinctly-named,
        // greppable line for this whole class of bug, whichever of the
        // causes above produced it.
        if (finalOutcome !== 'waiting_on_user') {
          logger.error(
            'task-execution: GraphInterrupt did not produce a waiting_on_user pause — treating as failure',
            { taskId: task.id, reason: recovered?.reason ?? 'recovery_guard_failed' },
          );
        }
      } else {
        logger.error('task-execution: run failed', { taskId: task.id, err: serializeError(err) });
        finalOutcome = 'failed';
        const outOfSteps = (err as Error).name === 'GraphRecursionError';
        const classified = classifyChatError(err, defaultProviderType());
        traceError = outOfSteps
          ? 'Ran out of steps before completing this task.'
          : classified.message;
        const failureSummary = outOfSteps ? traceError : `Run failed: ${classified.message}`;
        if (partialState && turnSentAt !== undefined) {
          if (outOfSteps) {
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
        await finishFailedRun((err as Error)?.message ?? 'Run failed.', failureSummary);
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
      // Guarded: a failed trace write must never skip the thread release
      // below (endThreadTurn) — this function never throws.
      try {
        await turnObs?.end(traceError);
      } catch (err) {
        logger.error('task-execution: failed to close run trace', {
          taskId: task.id,
          err: serializeError(err),
        });
      }
      recordMarker('end', finalOutcome);
      // Single choke point for the live-events broadcast (see
      // docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md) —
      // finalOutcome is already assigned by every branch above (both the
      // graceful try-block outcomes and all five catch-block cases), so this
      // covers every run without touching any of those branches themselves.
      // 'blocked' (a user-initiated pause, not a HITL wait) deliberately
      // broadcasts neither event: the task_queue_update from wake() already
      // reflects it, and there's no thread-side content to react to.
      for (const target of markerThreads) {
        if (finalOutcome === 'waiting_on_user') {
          broadcast({ type: 'hitl_prompt', threadId: target, taskId: task.id });
        } else if (
          finalOutcome === 'done' ||
          finalOutcome === 'failed' ||
          finalOutcome === 'cancelled'
        ) {
          broadcast({
            type: 'task_completed',
            threadId: target,
            taskId: task.id,
            outcome: finalOutcome,
          });
        }
      }
      endThreadTurn(threadId);
      clearTaskAbort(entry.id);
    }
  };

  await runOnceThreadFree(threadId, runClaimed);
}
