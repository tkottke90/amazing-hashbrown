import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const BlockOnUserActionSchema = z.object({
  note: z
    .string()
    .describe(
      'What the user specifically needs to do before this task can make any further progress.',
    ),
});

export type BlockOnUserActionCall = z.infer<typeof BlockOnUserActionSchema>;

export interface BlockOnUserActionOptions {
  // Fires only for an accepted call — mirrors hand-off-task.tool.ts's
  // onAccepted/handOffBox pattern. Every call is accepted; there is no
  // nudge-once gate here (see the function doc comment below for why).
  onAccepted?: (call: BlockOnUserActionCall) => void;
}

// Built fresh per automated task run, closed over that specific task's id —
// a sibling of hand-off-task.tool.ts's makeHandOffTaskTool, for the case
// where the blocker itself is outside the chat entirely (e.g. an OAuth
// consent flow, a credentials file) rather than something the user asked
// the agent to stop for, or a question the user could answer in-run.
//
// Unlike hand_off_task, this tool has no nudge-once gate: hand_off_task's
// gate exists to make sure an ask_user interrupt happened first, because
// hand_off_task is specifically for ending a run *after* the user asked to
// stop mid-conversation. An externally-blocked scenario isn't one ask_user
// could resolve either way, so there's nothing to nudge the agent toward
// trying first. See ADR-0059 and GLOSSARY.md's Externally-Blocked Hand-Off.
export function makeBlockOnUserActionTool(taskId: string, opts: BlockOnUserActionOptions = {}) {
  return tool(
    async ({ note }: BlockOnUserActionCall) => {
      opts.onAccepted?.({ note });
      return `Task ${taskId} blocked on user action: ${note}`;
    },
    {
      name: 'block_on_user_action',
      description:
        "Call this when the task's only remaining blocker is something only the user can do " +
        '— completing an external flow (e.g. an OAuth consent screen), providing a file or ' +
        'credential that does not exist yet, or any other action outside this conversation — ' +
        'and no further action in this run, including ask_user, would help. Not for when the ' +
        'user asked you to stop or step away (use hand_off_task for that), and not for ' +
        'something you could resolve by asking a question in chat (use ask_user for that).',
      schema: BlockOnUserActionSchema,
    },
  );
}
