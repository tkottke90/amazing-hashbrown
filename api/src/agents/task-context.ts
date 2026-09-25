import type { PlanStep } from '../services/workspace-store.js';

// Deliberately side-effect-free (type-only imports) — bin/eval.ts imports
// buildTaskContextBlock() directly to render a suite's simulatedTask into the
// real task-run system prompt, and must not pull in chat-agent.ts's
// import-time ToolsManager/MCP setup to do so. chat-agent.ts re-exports
// everything here for its existing importers. See
// docs/superpowers/specs/2026-09-25-task-plan-progress-design.md §1.

export interface TaskContext {
  title: string;
  description: string | null;
  outcome: string | null;
  plan?: PlanStep[] | null;
}

// One shared rendering for every place the agent sees a plan — the task
// system prompt, update_plan's return value, and complete_task's nudge — so
// the step numbers the agent reads are always the ones update_plan accepts
// (1-based).
export function formatPlanChecklist(plan: PlanStep[]): string {
  return plan.map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.step}`).join('\n');
}

// hasAskUser is false for buildSubAgentAgent — a sub-agent's tool list never
// includes ask_user, so telling it to call one would be actively wrong.
export function buildTaskContextBlock(ctx: TaskContext, hasAskUser = true): string {
  const lines = [`You are running an automated task: "${ctx.title}".`];
  if (ctx.description) lines.push(`Description: ${ctx.description}`);
  if (ctx.outcome) lines.push(`Outcome to reach: ${ctx.outcome}`);

  const hasPlan = Boolean(ctx.plan && ctx.plan.length > 0);
  if (hasPlan) {
    lines.push(
      '',
      'Plan (check steps off with update_plan as you finish them):',
      formatPlanChecklist(ctx.plan!),
    );
  }

  lines.push(
    '',
    (hasPlan ? 'Call update_plan to mark each plan step done as you complete it. ' : '') +
      'When the outcome has been met, or you cannot proceed further, call complete_task with ' +
      'outcome ("done" or "failed") and a summary.' +
      (hasAskUser
        ? ' If you need information only the user can provide, call ask_user — the run will ' +
          'pause and resume once they answer.'
        : ' No one is available to answer questions during this run — do your best with the ' +
          'information you have and report what you could not determine in your summary.'),
  );
  return lines.join('\n');
}
