import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger.js';
import { getWorkspaceStore, type Task } from '../services/workspace-store.js';
import { getThreadStore } from '../services/thread-store.js';
import { getChatAgent, getWorkspaceChatAgent, buildTaskAgent } from './chat-agent.js';
import { buildWorkspaceContext, resolveAllowedWikiId } from './workspace-chat-stream-handler.js';
import { runHeadlessTurn, type HeadlessAgent } from './headless-turn.js';
import { enqueuePendingTurn } from './pending-thread-turns.js';
import { recordSubAgentMarker } from './thread-message-writer.js';

export type SubAgentOutcome = 'done' | 'failed' | 'cancelled';

function buildNotificationMessage(
  task: Task,
  outcome: SubAgentOutcome,
  summary: string | undefined,
  remainingCount: number,
): string {
  const lines = [
    `Sub-agent [${task.role ?? 'unknown'}] ${outcome === 'done' ? 'completed' : outcome} — goal: "${task.title}".`,
  ];
  lines.push(summary ? `Summary: ${summary}` : 'No summary was provided.');
  lines.push(
    remainingCount > 0
      ? `${remainingCount} sibling sub-agent(s) from this dispatch are still running.`
      : 'No other sub-agents from this dispatch are still running.',
  );
  return lines.join('\n');
}

// Resolves the agent that should receive a sub-agent's completion turn,
// based on the parent thread's type — see
// docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §5-6.
// Returns null (logging why) when there is nothing to deliver into: the
// parent thread was deleted, or its type doesn't map to a known agent
// flavor. A global task's own dedicated thread is always type='task' —
// task-execution.ts only ever gives a workspace-scoped task's run
// workspace.threadId (type='workspace-chat') instead, so the 'task' branch
// here never needs a workspace scope.
async function resolveParentAgent(
  parentThreadId: string,
): Promise<{ agent: HeadlessAgent; workspaceId?: string; taskId?: string } | null> {
  const store = getWorkspaceStore();
  const threadStore = getThreadStore();
  const meta = threadStore.getThreadMeta(parentThreadId);
  if (!meta) {
    logger.warn('sub-agent-notification: parent thread not found, dropping notification', {
      parentThreadId,
    });
    return null;
  }

  switch (meta.type) {
    case 'workspace-chat': {
      const workspace = store.getWorkspaceByThreadId(parentThreadId);
      if (!workspace) {
        logger.warn('sub-agent-notification: workspace not found for parent thread', {
          parentThreadId,
        });
        return null;
      }
      const allowedWikiId = resolveAllowedWikiId(store, workspace.id);
      const workspaceContext = await buildWorkspaceContext(workspace);
      const { agent } = await getWorkspaceChatAgent(
        workspace.id,
        workspaceContext,
        undefined,
        undefined,
        allowedWikiId,
      );
      return { agent, workspaceId: workspace.id };
    }
    case 'task': {
      const parentTask = store.getTaskByThreadId(parentThreadId);
      if (!parentTask) {
        logger.warn('sub-agent-notification: task not found for parent thread', { parentThreadId });
        return null;
      }
      const { agent } = await buildTaskAgent(parentTask);
      return { agent, taskId: parentTask.id };
    }
    case 'chat': {
      const { agent } = await getChatAgent();
      return { agent };
    }
    default:
      logger.warn('sub-agent-notification: unsupported parent thread type, dropping notification', {
        parentThreadId,
        type: meta.type,
      });
      return null;
  }
}

// Delivers a spawn_sub_agent completion (done/failed/cancelled, and the
// origin='agent' crash-recovery branch) into its parent thread as its own
// turn — one turn per completion, never batched, carrying how many sibling
// sub-agents from the same dispatch are still non-terminal. Fire-and-forget
// from the caller's perspective (task-execution.ts never awaits full
// delivery, only this bookkeeping step) — the actual turn runs via
// pending-thread-turns.ts, queued behind any live turn already holding the
// parent thread's mutex. Never throws.
export async function deliverSubAgentCompletion(
  task: Task,
  outcome: SubAgentOutcome,
  summary?: string,
): Promise<void> {
  if (!task.parentThreadId || !task.dispatchGroupId) {
    logger.error('sub-agent-notification: origin=agent task missing parent/dispatch group', {
      taskId: task.id,
    });
    return;
  }
  const parentThreadId = task.parentThreadId;

  // Never throws — a notification-delivery failure must not affect the
  // sub-agent task's own already-decided outcome in task-execution.ts,
  // which calls this after finalOutcome/completeQueueEntry are settled.
  try {
    const store = getWorkspaceStore();
    const threadStore = getThreadStore();
    const remainingCount = store.countPendingSiblings(task.dispatchGroupId, task.id);

    recordSubAgentMarker(threadStore, parentThreadId, randomUUID(), {
      taskId: task.id,
      role: task.role ?? 'unknown',
      phase: 'completion',
      outcome,
      remainingCount,
    });

    const resolved = await resolveParentAgent(parentThreadId);
    if (!resolved) return;

    const message = buildNotificationMessage(task, outcome, summary, remainingCount);
    enqueuePendingTurn(parentThreadId, () =>
      runHeadlessTurn({
        threadId: parentThreadId,
        agent: resolved.agent,
        message,
        threadStore,
        workspaceId: resolved.workspaceId,
        taskId: resolved.taskId,
      }),
    );
  } catch (err) {
    logger.error('sub-agent-notification: failed to deliver completion', {
      taskId: task.id,
      parentThreadId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
