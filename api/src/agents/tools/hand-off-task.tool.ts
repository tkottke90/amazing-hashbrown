import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const HandOffTaskSchema = z.object({
  summary: z
    .string()
    .describe(
      'What was accomplished so far, and where things stand now for whoever picks this up next.',
    ),
});

export type HandOffTaskCall = z.infer<typeof HandOffTaskSchema>;

export interface HandOffTaskOptions {
  // Whether an ask_user interrupt has already occurred earlier in this run
  // (i.e. entry.pauseReason === 'chat') — read once at agent-build time, the
  // same way a HITL resume rebuilds the agent before this tool is ever
  // callable again. See hand-off-task's nudge-once rule below.
  hadHitlInterrupt?: boolean;
  // Fires only for an accepted call — the single source of truth for "this
  // run handed off" in task-execution.ts, mirroring complete_task's
  // onAccepted/completeTaskBox pattern. A nudged (rejected) call never
  // reaches it.
  onAccepted?: (call: HandOffTaskCall) => void;
}

// Built fresh per automated task run, closed over that specific task's id —
// a direct sibling of complete-task.tool.ts's makeCompleteTaskTool, for the
// case where the user asks the run to stop mid-HITL rather than the task's
// outcome actually being met or unreachable.
//
// Nudge-once: the first call made with no prior ask_user interrupt in this
// run is rejected, pointing the agent at complete_task (if the goal is
// actually met/unreachable) or ask_user (if it needs to ask something new)
// instead. A second call is accepted regardless, so an agent that correctly
// judges a handoff is warranted is never trapped. See
// docs/superpowers/specs/2026-11-01-handed-off-run-outcome-design.md §3.1.
export function makeHandOffTaskTool(taskId: string, opts: HandOffTaskOptions = {}) {
  let nudged = false;

  return tool(
    async ({ summary }: HandOffTaskCall) => {
      if (!opts.hadHitlInterrupt && !nudged) {
        nudged = true;
        return (
          'No ask_user interrupt has occurred yet in this run — hand_off_task is only for ' +
          "ending the run after the user has asked you to stop. If the task's outcome has " +
          'been met or is unreachable, call complete_task instead. If you need to ask the ' +
          'user something, call ask_user. If you really do need to hand off, call ' +
          'hand_off_task again.'
        );
      }

      opts.onAccepted?.({ summary });
      return `Task ${taskId} handed off: ${summary}`;
    },
    {
      name: 'hand_off_task',
      description:
        'Call this to end the run cooperatively when the user has asked you to stop or step ' +
        "away mid-conversation, after an ask_user question — not when the task's outcome has " +
        'been met or is unreachable (use complete_task for that), and not when you need to ' +
        'ask something new (use ask_user for that).',
      schema: HandOffTaskSchema,
    },
  );
}
