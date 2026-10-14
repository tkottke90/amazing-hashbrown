import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { getWorkspaceStore } from '../../services/workspace-store.js';

const TASK_STATUSES = [
  'pending',
  'scheduled',
  'ready',
  'running',
  'waiting_on_user',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;

const STREAK_STATUSES = new Set(['failed', 'blocked']);

const ListTasksSchema = z.object({
  status: z.enum(TASK_STATUSES).optional().describe('Only return tasks in this status.'),
  titleContains: z
    .string()
    .optional()
    .describe('Case-insensitive substring to narrow results by title.'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('Default 20, max 100.'),
  offset: z.number().int().min(0).optional().default(0),
});

// The "locate" step for workspace chat's task-visibility tools — mirrors
// wiki_locate's role relative to wiki_create_page/wiki_read_page: this
// returns however many rows match a plain filter; get_task_outcome and
// read_workspace_task_run then take only an exact taskId already seen here,
// rather than doing their own free-text resolution. See
// docs/superpowers/specs/2026-10-13-workspace-task-visibility-design.md §2-3.
export const listTasksTool = tool(
  async ({ status, titleContains, limit, offset }, runtime: ToolRuntime) => {
    const workspaceId = runtime.configurable?.workspaceId as string | undefined;
    if (!workspaceId) {
      return 'Cannot list tasks: no active workspace.';
    }

    const store = getWorkspaceStore();
    let tasks = store.listTasks({ workspaceId, status });
    if (titleContains) {
      const needle = titleContains.toLowerCase();
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(needle));
    }

    if (tasks.length === 0) {
      const filters = [
        status ? `status: ${status}` : null,
        titleContains ? `title contains "${titleContains}"` : null,
      ].filter((f): f is string => f !== null);
      return filters.length > 0 ? `No tasks match (${filters.join(', ')}).` : 'No tasks found.';
    }

    const page = tasks.slice(offset, offset + limit);
    const streakIds = page.filter((t) => STREAK_STATUSES.has(t.status)).map((t) => t.id);
    const streaks = store.failedRunStreaks(streakIds);

    const lines = page.map((t) => {
      const streak = streaks.get(t.id);
      const streakText = streak
        ? ` — failed ${streak.attempts}x, last: ${streak.lastSummary ?? '(no summary recorded)'}`
        : '';
      return `- ${t.id} "${t.title}" (${t.status})${streakText}`;
    });

    const last = offset + page.length;
    const footer =
      last < tasks.length
        ? `(tasks ${offset + 1}–${last} of ${tasks.length}; call again with offset=${last} for more)`
        : `(tasks ${offset + 1}–${last} of ${tasks.length})`;
    return [...lines, footer].join('\n');
  },
  {
    name: 'list_tasks',
    description:
      'List tasks in this workspace, optionally filtered by status or a title substring. ' +
      'Use this to find a task before calling get_task_outcome or read_workspace_task_run.',
    schema: ListTasksSchema,
  },
);
