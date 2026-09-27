import { randomUUID } from 'node:crypto';
import { logger } from '../config/logger.js';
import { getWorkspaceStore, type Task } from '../services/workspace-store.js';
import { getThreadStore } from '../services/thread-store.js';
import { runHeadlessTurn } from './headless-turn.js';
import { resolveThreadAgent } from './resolve-thread-agent.js';
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

    const resolved = await resolveThreadAgent(parentThreadId);
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
        source: 'sub_agent',
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
