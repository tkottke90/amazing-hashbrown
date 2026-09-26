import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { PlanStep } from '../../services/workspace-store.js';
import { formatPlanChecklist } from '../task-context.js';

const CompleteTaskSchema = z.object({
  outcome: z
    .enum(['done', 'failed'])
    .describe('"done" if the task\'s outcome was met, "failed" if you cannot proceed further.'),
  summary: z.string().describe('A short summary of what was accomplished or why it failed.'),
});

export type CompleteTaskCall = z.infer<typeof CompleteTaskSchema>;

export interface CompleteTaskOptions {
  // Read at call time (not at build time) so steps checked earlier in the
  // same run via update_plan count. Omitted for sub-agent runs and
  // sub-agent-notification.ts's parent-task turn, which never nudge.
  getPlan?: () => PlanStep[] | null;
  // Fires only for an accepted call — the single source of truth for "this
  // run completed" in task-execution.ts. A nudged (rejected) call never
  // reaches it.
  onAccepted?: (call: CompleteTaskCall) => void;
}

// Built fresh per automated task run, closed over that specific task's id
// (mirrors makeWikiCreatePageTool's per-construction factory pattern) — this
// tool never appears in interactive chat/workspace-chat agents.
//
// Nudge-once: the first "done" call made while plan steps are still
// unchecked is rejected with the list of unchecked steps, so an agent that
// did the work but forgot to check it off gets a chance to fix the
// checklist. A second "done" call is accepted regardless, so an agent that
// deliberately skipped a step is never trapped. The flag lives in this
// closure, i.e. per agent build — a HITL resume rebuilds the agent and can
// nudge once more. See
// docs/superpowers/specs/2026-09-25-task-plan-progress-design.md §3.
export function makeCompleteTaskTool(taskId: string, opts: CompleteTaskOptions = {}) {
  let nudged = false;

  return tool(
    async ({ outcome, summary }: CompleteTaskCall) => {
      if (outcome === 'done' && !nudged && opts.getPlan) {
        const plan = opts.getPlan() ?? [];
        const unchecked = plan.flatMap((s, i) => (s.done ? [] : [i + 1]));
        if (unchecked.length > 0) {
          nudged = true;
          const noun = unchecked.length === 1 ? 'step' : 'steps';
          const verb = unchecked.length === 1 ? 'is' : 'are';
          return (
            `Not completed: ${noun} ${unchecked.join(', ')} ${verb} still unchecked. ` +
            'Mark them done with update_plan if you finished them, or call complete_task ' +
            `again if they were intentionally skipped.\n${formatPlanChecklist(plan)}`
          );
        }
      }

      opts.onAccepted?.({ outcome, summary });
      return `Task ${taskId} marked ${outcome}: ${summary}`;
    },
    {
      name: 'complete_task',
      description:
        "Call this when the task's outcome has been met, or when you cannot proceed further. " +
        'This ends the automated run.',
      schema: CompleteTaskSchema,
    },
  );
}
