import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';

// Must match playwright.config.ts's CHAT_IDLE_RESUME_MS override for the api
// webServer. In dev/prod this delay is 30s (see task-scheduler.ts); e2e
// shortens it so pause/resume tests don't burn 30+ real seconds per
// assertion. The whole e2e run shares one api server process, so every spec
// file — @llm-tagged or not — sees the same shortened delay.
export const IDLE_RESUME_MS = 3000;

// The sidebar Queue widget polls GET /api/v1/tasks/queue every 10s — see
// thread-sidebar.tsx. Fast-forward the *browser's* virtual clock past that
// (via page.clock, installed by the caller) to see widget updates without a
// real wait. This only reaches browser-side timers: the scheduler's resume
// delay above runs as a setTimeout in the separate Node API process, which
// page.clock cannot touch — that's why it's controlled via env var instead
// (see playwright.config.ts and task-scheduler.ts).
export const WIDGET_POLL_FAST_FORWARD_MS = 11_000;

export type QueueState = {
  paused: boolean;
  running: { taskId: string } | null;
  queue: Array<{ taskId: string; status: string }>;
};

export async function getQueue(request: APIRequestContext): Promise<QueueState> {
  const res = await request.get('/api/v1/tasks/queue');
  expect(res.status()).toBe(200);
  return res.json() as Promise<QueueState>;
}

// Fire-and-forget a chat send. We only need the request handler to *start*
// (getTaskScheduler().pause() runs synchronously at the top of every chat
// entry point, before any provider call) — not for the turn to finish, which
// may depend on an LLM being configured in this environment. Errors (e.g. no
// provider configured) are expected and ignored: the pause/resume behaviour
// under test doesn't depend on the turn succeeding — see stream-handler.ts's
// outer try/finally, which arms the resume timer on any exit path.
export function sendChatFireAndForget(request: APIRequestContext, content: string): void {
  void request
    .post(`/api/v1/chat/${randomUUID()}`, { data: { content }, timeout: 10_000 })
    .catch(() => {});
}
