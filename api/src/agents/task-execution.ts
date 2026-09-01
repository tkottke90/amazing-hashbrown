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
  drainAndRecordWikiUpdates,
  extractPartialAssistantState,
} from './stream-handler.js';
import { buildTaskAgent, type WorkspaceChatContext } from './chat-agent.js';
import { buildWorkspaceContext, resolveAllowedWikiId } from './workspace-chat-stream-handler.js';
import {
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  recordTaskRunMarker,
} from './thread-message-writer.js';

export type QueueEntryWithTask = TaskQueueEntry & { task: Task };

interface WorkspaceScope {
  workspace: Workspace;
  workspaceContext: WorkspaceChatContext;
  allowedWikiId?: string;
}

interface CompleteTaskCall {
  outcome: 'done' | 'failed';
  summary: string;
}

// Wraps the raw LangGraph event stream, capturing complete_task's call
// arguments as a side effect while yielding every event through unchanged —
// pipeEvents itself needs no changes to support this (it already has its own
// on_tool_start/on_tool_end handling and just doesn't report back which
// tools were called).
async function* tapCompleteTask(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: AsyncIterable<any>,
  onComplete: (result: CompleteTaskCall) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AsyncGenerator<any> {
  for await (const evt of stream) {
    if (evt.event === 'on_tool_start' && evt.name === 'complete_task') {
      const input = evt.data?.input as Partial<CompleteTaskCall> | undefined;
      if (input?.outcome) {
        onComplete({ outcome: input.outcome, summary: input.summary ?? '' });
      }
    }
    yield evt;
  }
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
    clearTaskAbort(entry.id);
    return;
  }

  // No live SSE connection drives this run (the scheduler invoked it, not an
  // HTTP request) — this sink only matters as (a) the concurrency mutex
  // workspace-chat-stream-handler.ts checks via getActiveSseWriter, and (b)
  // a forwarding shim for the rare case a client is already watching this
  // exact thread's own active writer slot (there isn't a general broadcast
  // mechanism today — see the design doc's scope note).
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

  try {
    recordTaskRunMarker(threadStore, threadId, randomUUID(), task.id, task.title, 'start');
    drainAndRecordWikiUpdates(sink, threadStore, threadId);

    const { agent } = await buildAgent(
      task,
      undefined,
      undefined,
      workspaceScope
        ? {
            workspaceContext: workspaceScope.workspaceContext,
            allowedWikiId: workspaceScope.allowedWikiId,
          }
        : undefined,
    );

    const config = {
      configurable: {
        thread_id: threadId,
        ...(workspaceScope ? { workspaceId: workspaceScope.workspace.id } : {}),
      },
    };
    msgId = randomUUID();
    turnSentAt = new Date().toISOString();
    const startedAt = Date.now();
    const assistantSeq = recordAssistantStart(threadStore, threadId, msgId, turnSentAt);

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

    // A boxed value rather than a bare `let` — TS's control-flow narrowing
    // can't see the reassignment happening inside tapCompleteTask's callback,
    // so a bare variable would narrow to `null` at the check below.
    const completeTaskBox: { current: CompleteTaskCall | null } = { current: null };
    const rawStream = agent.streamEvents(input, {
      ...config,
      version: 'v2',
      recursionLimit: env.agent?.recursionLimit ?? 100,
      signal: controller.signal,
      context: {
        provider: env.defaultProvider,
        model: undefined,
        afterAgentEnabled: undefined,
      },
    });
    const tapped = tapCompleteTask(rawStream, (result) => {
      completeTaskBox.current = result;
    });

    const { content, thoughtContent, finalSegmentId } = await pipeEvents(
      sink,
      msgId,
      tapped,
      threadStore,
      threadId,
      turnSentAt,
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
      turnSentAt,
      assistantSeq,
      null,
      undefined,
      undefined,
      undefined,
      task.id,
    );

    if (completeTaskBox.current) {
      finalOutcome = completeTaskBox.current.outcome;
      store.completeQueueEntry(entry.id, completeTaskBox.current.outcome);
    } else if (interrupted) {
      finalOutcome = 'waiting_on_user';
      // completeQueueEntry() mirrors its outcome onto tasks.status too — it
      // must run BEFORE patchTask here, or it would clobber waiting_on_user
      // straight back to 'done'.
      store.completeQueueEntry(entry.id, 'done');
      store.patchTask(task.id, { status: 'waiting_on_user', assignedTo: 'user' });
    } else {
      // The agent stopped without calling complete_task or ask_user — e.g.
      // it trailed off, or hit GraphRecursionError inside pipeEvents/
      // finalizeTurn. This is exactly the bug #87 exists to fix: never leave
      // the task stuck in 'running'.
      finalOutcome = 'failed';
      store.completeQueueEntry(entry.id, 'failed');
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
    const partialState = msgId !== undefined ? extractPartialAssistantState(err, msgId) : undefined;

    if (intent === 'cancel') {
      logger.info('task-execution: run cancelled', { taskId: task.id });
      finalOutcome = 'cancelled';
      store.completeQueueEntry(entry.id, 'cancelled');
    } else if (intent === 'pause') {
      logger.info('task-execution: run paused', { taskId: task.id });
      finalOutcome = 'blocked';
      store.parkQueueEntry(entry.id);
    } else if (intent === 'take-over') {
      logger.info('task-execution: run taken over', { taskId: task.id });
      finalOutcome = 'cancelled';
      store.detachQueueEntry(entry.id);
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
          failAssistant(
            threadStore,
            threadId,
            partialState.segmentId,
            partialState.content,
            turnSentAt,
            partialState.thoughtContent,
          );
        }
      }
      store.completeQueueEntry(entry.id, 'failed');
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
    clearActiveSseWriter(threadId);
    clearTaskAbort(entry.id);
  }
}
