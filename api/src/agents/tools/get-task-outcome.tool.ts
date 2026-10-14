import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { getWorkspaceStore, type TaskRun } from '../../services/workspace-store.js';

const GetTaskOutcomeSchema = z.object({
  taskId: z
    .string()
    .describe(
      'The exact id of the task. If you already have it — the user gave it directly, or you ' +
        'already saw it from list_tasks or elsewhere in this conversation — call this ' +
        'immediately with that id; do not call list_tasks first just to re-confirm an id you ' +
        'already have.',
    ),
});

const MAX_PAST_RUNS_SHOWN = 10;

function describeRun(run: TaskRun): string {
  return `#${run.runNumber} ${run.id} (${run.status}, via ${run.triggerSource})`;
}

// get_task_outcome / read_workspace_task_run take only an exact taskId,
// already resolved via list_tasks — see that tool's own comment and
// docs/superpowers/specs/2026-10-13-workspace-task-visibility-design.md §2-3
// for why free-text resolution does not belong in this "read" tool.
//
// Branches on the TASK's own status (Task.status), not the latest run's own
// TaskQueueEntry status — the two are separate enums (e.g. a task can be
// 'blocked' while its latest run settled 'failed'). See §3's state table.
export const getTaskOutcomeTool = tool(
  async ({ taskId }, runtime: ToolRuntime) => {
    const workspaceId = runtime.configurable?.workspaceId as string | undefined;
    if (!workspaceId) {
      return 'Cannot look up tasks: no active workspace.';
    }

    const store = getWorkspaceStore();
    const task = store.getTask(taskId);
    if (!task || task.workspaceId !== workspaceId) {
      return `No task with id "${taskId}" in this workspace.`;
    }

    const runs = store.listTaskRuns(taskId);
    const header = `"${task.title}" — status: ${task.status}`;

    if (runs.length === 0) {
      return `${header}\nHas not run yet.`;
    }

    const latest = runs[0]!;
    const lines = [header];

    switch (task.status) {
      case 'running':
        lines.push(
          `Currently running — ${describeRun(latest)}` +
            (latest.startedAt ? `, started at ${latest.startedAt}` : ''),
        );
        break;
      case 'blocked':
        lines.push(`Blocked${task.blockedReason ? ` (${task.blockedReason})` : ''}.`);
        if (latest.summary) lines.push(`Latest run summary: ${latest.summary}`);
        break;
      case 'failed': {
        lines.push(
          `Latest run (${describeRun(latest)}): ${latest.summary ?? '(no summary recorded)'}`,
        );
        const streak = store.failedRunStreaks([taskId]).get(taskId);
        if (streak && streak.attempts > 1) {
          lines.push(`Failed ${streak.attempts}x in a row. Last: ${streak.lastSummary}`);
        }
        break;
      }
      case 'done':
        lines.push(
          `Completed successfully (${describeRun(latest)}): ${latest.summary ?? '(no summary recorded)'}`,
        );
        break;
      default:
        lines.push(
          `Latest run (${describeRun(latest)}): ${latest.summary ?? '(no summary recorded)'}`,
        );
    }

    const shown = runs.slice(0, MAX_PAST_RUNS_SHOWN);
    lines.push(
      `Past runs (${shown.length} of ${runs.length} shown): ${shown.map(describeRun).join('; ')}`,
    );
    lines.push('Use read_workspace_task_run with one of these run ids for the full transcript.');

    return lines.join('\n');
  },
  {
    name: 'get_task_outcome',
    description:
      'Get the status and latest-run outcome of a task in this workspace, including why it ' +
      'failed if it did. Call this directly whenever you already know the exact taskId — ' +
      'e.g. the user named it, or gave an id in their message. Only call list_tasks first ' +
      'when you do not yet know which task they mean.',
    schema: GetTaskOutcomeSchema,
  },
);
