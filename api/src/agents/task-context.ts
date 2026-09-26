import type { PlanStep, TriggerSource } from '../services/workspace-store.js';

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
    (hasPlan
      ? "Call update_plan to mark each plan step done as you complete it. The moment a step's " +
        'deliverable is finished — a file written, a command that verifies it passing — your ' +
        "very next tool call is update_plan for that step, before starting the next step's " +
        'work or moving on in any other way. Trust a tool result already shown earlier in this ' +
        'conversation: if it already demonstrates a step is done (a passing test run, a file ' +
        'whose contents already match the plan), check that step off directly rather than ' +
        're-running the same check again just to confirm something you can already see. This ' +
        'applies just as much right after complete_task rejects a "done" call for unchecked ' +
        'steps: if the work those steps needed already ran and succeeded earlier in this same ' +
        'conversation, respond with update_plan checking them off directly — the nudge is ' +
        'asking you to update the checklist to match reality, not asking you to redo the work ' +
        'or repeat a check you already have the answer to. '
      : '') +
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

// ---------------------------------------------------------------------------
// Run kickoff message
// ---------------------------------------------------------------------------

// A finished earlier run of the same task, as the kickoff message lists it.
export interface PreviousRun {
  id: string;
  runNumber: number;
  status: string;
  startedAt: string | null;
  summary: string | null;
}

export interface RunKickoffInput {
  title: string;
  // A HITL answer or user Resume continuing a run that already started —
  // its thread already holds everything, so no run/history block.
  resume: boolean;
  runNumber: number;
  triggerSource: TriggerSource;
  scheduledFor?: string | null;
  // Newest first; only finished runs that have a transcript to read.
  previousRuns: PreviousRun[];
  timeZone?: string;
}

// Previous run + this many older ones — enough to spot a pattern, small
// enough that the kickoff stays a few lines.
const EARLIER_RUNS_SHOWN = 3;

// "2026-09-25 00:00 UTC" — a fixed, unambiguous rendering for the model.
export function formatRunTime(iso: string, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${timeZone}`;
}

const SOURCE_PHRASE: Record<TriggerSource, string> = {
  manual: 'started manually',
  webhook: 'started by a webhook call',
  chat: 'created from chat',
  agent: 'spawned as a sub-agent',
  schedule: 'started by its schedule',
  catch_up: 'started by its schedule',
};

// The human turn that opens a task run. Every run starts in a fresh thread,
// so this is the only thing carrying continuity between runs: the previous
// run's one-line summary, plus the exact read_task_run call that opens its
// full transcript (the tool is never described in the system prompt — see
// docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §3).
export function buildRunKickoff(input: RunKickoffInput): string {
  if (input.resume) {
    return `Resume this task — continue from where you left off: ${input.title}.`;
  }

  const tz = input.timeZone ?? 'UTC';
  const lines = [`Begin work on this task now: ${input.title}.`];
  const scheduled = input.triggerSource === 'schedule' || input.triggerSource === 'catch_up';
  const [previous, ...earlier] = input.previousRuns;

  if (scheduled) {
    lines.push(
      `This is scheduled run #${input.runNumber}` +
        (input.scheduledFor ? ` (scheduled for ${formatRunTime(input.scheduledFor, tz)}).` : '.'),
    );
    if (input.triggerSource === 'catch_up') {
      lines.push('This is a catch-up run — the server was offline at the scheduled time.');
    }
  } else if (previous) {
    lines.push(`This is run #${input.runNumber} (${SOURCE_PHRASE[input.triggerSource]}).`);
  }

  if (previous) {
    const when = previous.startedAt ? `${formatRunTime(previous.startedAt, tz)}, ` : '';
    lines.push(
      '',
      `Previous run — #${previous.runNumber}, ${when}${previous.status}:`,
      `"${previous.summary ?? 'No summary was recorded.'}"`,
      `For full details call: read_task_run(${JSON.stringify({ runId: previous.id })})`,
    );
    const shown = earlier.slice(0, EARLIER_RUNS_SHOWN);
    if (shown.length > 0) {
      lines.push(
        '',
        'Earlier runs: ' + shown.map((r) => `#${r.runNumber} ${r.id} (${r.status})`).join(', '),
      );
    }
  }

  return lines.join('\n');
}
