import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWakeupStore } from '../../services/wakeup-store.js';
import { getWakeupRegistry } from '../../services/wakeup-registry.js';

export const CancelWakeupSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe('Why the wait is no longer needed — shown to the user on the wake-up card.'),
});

// Cancels this thread's pending wake-up, e.g. when the thing being waited on
// finished early. Companion to schedule_wakeup; bound for the same agents.
export const cancelWakeupTool = tool(
  async ({ reason }, config) => {
    const threadId = config?.configurable?.thread_id as string | undefined;
    if (!threadId) return 'Cannot cancel a wake-up: there is no active thread.';

    const pending = getWakeupStore().getPending(threadId);
    if (!pending) return 'No wake-up is pending in this thread.';

    const cancelled = getWakeupRegistry().cancel(pending.id, 'agent_cancel', reason);
    return cancelled
      ? 'Cancelled the pending wake-up.'
      : 'The wake-up had already fired or been cancelled.';
  },
  {
    name: 'cancel_wakeup',
    description:
      "Cancel this conversation's pending wake-up (scheduled with schedule_wakeup), e.g. because " +
      'what you were waiting for already finished.',
    schema: CancelWakeupSchema,
  },
);
