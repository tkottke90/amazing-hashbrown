import { expect, type APIRequestContext } from '@playwright/test';

// The sidebar Queue widget polls GET /api/v1/tasks/queue every 10s — see
// thread-sidebar.tsx. Fast-forward the *browser's* virtual clock past that
// (via page.clock, installed by the caller) to see widget updates without a
// real wait.
export const WIDGET_POLL_FAST_FORWARD_MS = 11_000;

export type QueueState = {
  running: Array<{ taskId: string }>;
  queue: Array<{ taskId: string; status: string }>;
};

export async function getQueue(request: APIRequestContext): Promise<QueueState> {
  const res = await request.get('/api/v1/tasks/queue');
  expect(res.status()).toBe(200);
  return res.json() as Promise<QueueState>;
}
