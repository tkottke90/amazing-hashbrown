import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  getWakeupStore,
  PendingWakeupExistsError,
  WAKEUP_MAX_CHAIN,
  WAKEUP_MAX_DELAY_S,
  WAKEUP_MIN_DELAY_S,
} from '../../services/wakeup-store.js';
import { getWakeupRegistry } from '../../services/wakeup-registry.js';
import { formatElapsed } from '../wakeup-delivery.js';

export const ScheduleWakeupSchema = z.object({
  delaySeconds: z
    .number()
    .describe(
      `How long to wait before you are resumed, in seconds (${WAKEUP_MIN_DELAY_S}–${WAKEUP_MAX_DELAY_S}).`,
    ),
  note: z
    .string()
    .describe(
      'Instructions to your future self: what to check when you wake and exactly how (the command, URL or file).',
    ),
});

// Lets the agent wait for something external (a deploy, CI, a server
// starting) without sleeping inside its turn: it schedules a wake-up, ends
// its turn, and is resumed in this same thread with its note when the
// wake-up fires. Bound only for chat and workspace-chat agents. Validation
// failures come back as plain tool results (not thrown) so the model can
// correct itself. See docs/superpowers/specs/2026-09-27-agent-wait-design.md §4.
export const scheduleWakeupTool = tool(
  async ({ delaySeconds, note }, config) => {
    const threadId = config?.configurable?.thread_id as string | undefined;
    if (!threadId) return 'Cannot schedule a wake-up: there is no active thread to resume.';

    const delay = Math.round(delaySeconds);
    if (!Number.isFinite(delay) || delay < WAKEUP_MIN_DELAY_S || delay > WAKEUP_MAX_DELAY_S) {
      return (
        `delaySeconds must be between ${WAKEUP_MIN_DELAY_S} and ${WAKEUP_MAX_DELAY_S} ` +
        `(${formatElapsed(WAKEUP_MAX_DELAY_S * 1000)}). For anything longer, tell the user — ` +
        'that is a scheduled task, not a wait.'
      );
    }
    const trimmedNote = note.trim();
    if (!trimmedNote) return 'note is required: say what to check when you wake and how.';

    const store = getWakeupStore();
    const pending = store.getPending(threadId);
    if (pending) return alreadyPending(pending.id, pending.fireAt);

    const parentDepth = config?.configurable?.wakeupDepth as number | undefined;
    const chainDepth = (parentDepth ?? 0) + 1;
    if (chainDepth > WAKEUP_MAX_CHAIN) {
      return (
        `You have woken yourself ${WAKEUP_MAX_CHAIN} times without the user replying. ` +
        'Stop waiting and report the current status to the user.'
      );
    }

    let wakeup;
    try {
      wakeup = store.schedule({
        threadId,
        note: trimmedNote,
        fireAt: new Date(Date.now() + delay * 1000),
        chainDepth,
      });
    } catch (err) {
      if (err instanceof PendingWakeupExistsError) {
        const current = store.getPending(threadId);
        if (current) return alreadyPending(current.id, current.fireAt);
      }
      throw err;
    }
    getWakeupRegistry().sync(wakeup.id);

    return (
      `Wake-up scheduled: you will be resumed in ${formatElapsed(delay * 1000)} (at ${wakeup.fireAt}) ` +
      'with your note. End your turn now with a one-line status for the user.'
    );
  },
  {
    name: 'schedule_wakeup',
    description:
      'Wait for something external (a deploy, CI, a long-running command, a server starting) ' +
      'without blocking: schedules a wake-up, after which you must end your turn. When it fires ' +
      'you are resumed in this conversation with your note. Use this instead of sleeping in the ' +
      'shell. Not for reminding the user of something.',
    schema: ScheduleWakeupSchema,
  },
);

function alreadyPending(id: string, fireAt: string): string {
  return (
    `A wake-up is already pending in this thread (id ${id}, fires at ${fireAt}). ` +
    'Call cancel_wakeup first if you want to replace it.'
  );
}
