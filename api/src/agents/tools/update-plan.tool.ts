import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { broadcast } from '../../services/broadcast.js';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { formatPlanChecklist } from '../task-context.js';

const UpdatePlanSchema = z.object({
  updates: z
    .array(
      z.object({
        step: z
          .number()
          .int()
          .min(1)
          .describe('The plan step number, exactly as shown in the plan (the first step is 1).'),
        done: z.boolean().describe('true to check the step off, false to uncheck it.'),
      }),
    )
    .min(1)
    .describe('One entry per plan step to change.'),
});

// Built fresh per automated task run, closed over that task's id (same
// per-construction factory pattern as makeCompleteTaskTool), with an
// optionally injected store (same testability pattern as
// makeCreateTasksTool). Toggle-only by design: step text and count stay
// human-owned so the checklist remains an honest record of the agreed plan
// versus what was actually done. Bound only in buildTaskAgent — never in
// interactive chat or sub-agent runs. See
// docs/superpowers/specs/2026-09-25-task-plan-progress-design.md §2.
export function makeUpdatePlanTool(taskId: string, store?: WorkspaceStore) {
  return tool(
    async ({ updates }: z.infer<typeof UpdatePlanSchema>) => {
      const s = store ?? getWorkspaceStore();
      // Re-read on every call rather than trusting a copy from run start — a
      // human may have toggled steps in the Task Drawer mid-run.
      const task = s.getTask(taskId);
      if (!task) return `Cannot update plan: task ${taskId} was not found.`;

      const plan = task.plan ?? [];
      if (plan.length === 0) return 'This task has no plan steps to update.';

      // All-or-nothing: one bad step number rejects the whole call so the
      // agent never ends up with a partially applied batch it can't see.
      const invalid = updates.filter((u) => u.step > plan.length).map((u) => u.step);
      if (invalid.length > 0) {
        return (
          `Plan not updated: step ${invalid.join(', ')} does not exist. ` +
          `Valid steps are 1-${plan.length}:\n${formatPlanChecklist(plan)}`
        );
      }

      // Later entries for the same step win, matching the order the agent
      // listed them in.
      const doneByIndex = new Map(updates.map((u) => [u.step - 1, u.done]));
      const next = plan.map((p, i) => ({ ...p, done: doneByIndex.get(i) ?? p.done }));

      s.patchTask(taskId, { plan: next });
      broadcast({ type: 'task_plan_updated', taskId, plan: next });

      return `Plan updated:\n${formatPlanChecklist(next)}`;
    },
    {
      name: 'update_plan',
      description:
        "Check off (or uncheck) steps in this task's plan as you complete them. " +
        'Refer to steps by the number shown in the plan. Returns the updated plan.',
      schema: UpdatePlanSchema,
    },
  );
}
