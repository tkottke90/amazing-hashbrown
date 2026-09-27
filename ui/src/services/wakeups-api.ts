import { request } from '@/utils/fetch.utils';
import type { WakeupThreadMessage } from '@/types/thread-message';

// The card fields the server returns after a Cancel / Trigger now — the
// `wakeup` message minus its row identity.
export type WakeupCardPayload = Omit<WakeupThreadMessage, 'kind' | 'id' | 'seq'>;

function wakeupUrl(threadId: string, wakeupId: string, action: 'cancel' | 'trigger'): string {
  return `/api/v1/threads/${encodeURIComponent(threadId)}/wakeups/${encodeURIComponent(wakeupId)}/${action}`;
}

export async function cancelWakeup(threadId: string, wakeupId: string): Promise<WakeupCardPayload> {
  return request<WakeupCardPayload>(wakeupUrl(threadId, wakeupId, 'cancel'), { method: 'POST' });
}

export async function triggerWakeup(
  threadId: string,
  wakeupId: string,
): Promise<WakeupCardPayload> {
  return request<WakeupCardPayload>(wakeupUrl(threadId, wakeupId, 'trigger'), { method: 'POST' });
}
