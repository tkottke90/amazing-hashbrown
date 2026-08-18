import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
import {
  IDLE_RESUME_MS,
  WIDGET_POLL_FAST_FORWARD_MS,
  getQueue,
  sendChatFireAndForget,
  sendHitlResumeFireAndForget,
} from '../lib/scheduler.js';

const suite: TestSuite = {
  id: 7,
  name: 'Task Queue Widget',
  description:
    'Verifies the sidebar Queue widget becomes visible when a task is enqueued, and that a chat message (plain send or HITL resume) pauses the queue (widget flips to "Paused"), auto-resumes after the idle delay, resets its timer on new chat activity, and holds newly-enqueued tasks pending while paused — issue #68',
  purpose:
    'Ensure the queue widget shows current task name and status after enqueue, and that background task work never competes with an active chat turn but resumes on its own once the user goes idle',
  tags: ['@user-workflow', '@functional'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Create workspace and task via API, then enqueue it',
      expectedOutcome: 'Queue widget is visible with the task title and "running" status',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Send a chat message',
      expectedOutcome:
        'Queue widget flips to "Paused — chat active…"; after the idle delay it flips back to "running" on its own',
      test: () => {},
    },
    {
      tags: ['@functional'],
      action: 'Send a second chat message before the idle timer fires',
      expectedOutcome: 'The idle timer resets — the queue stays paused past the original deadline',
      test: () => {},
    },
    {
      tags: ['@functional'],
      action: 'Enqueue a new task while the queue is paused',
      expectedOutcome: 'The new task stays pending for the duration of the pause, not running',
      test: () => {},
    },
    {
      tags: ['@functional'],
      action: 'Answer a HITL prompt via POST /:threadId/hitl',
      expectedOutcome:
        'The HITL-resume entry point pauses and later auto-resumes the queue exactly like a plain chat send',
      test: () => {},
    },
  ],
};

// The TaskScheduler paused/resume-timer state is a single process-wide
// singleton (see task-scheduler.ts) — not scoped per test or thread — so
// these tests share it deliberately: the first test's enqueued task is the
// one every later test in this file pauses/resumes around. Serial mode keeps
// them from interleaving with each other under Playwright's default
// per-test parallelism, and stops the run on the first failure since every
// later test depends on the earlier ones' state.
test.describe.configure({ mode: 'serial' });

test.describe(
  '@user-workflow @functional',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    let sharedTaskId: string;
    const sharedTaskTitle = 'Queued task title';

    test('queue widget appears and shows task when enqueued', async ({
      page,
      request,
    }, testInfo) => {
      // Create workspace via API
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'queue-widget-ws', location: '/tmp/queue-widget-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      // Create task via API
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: sharedTaskTitle, workspaceId: ws.id, assignedTo: 'agent' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();
      sharedTaskId = task.id;

      // Enqueue the task
      const enqRes = await request.post(`/api/v1/tasks/${task.id}/enqueue`);
      expect(enqRes.status()).toBe(201);

      // Navigate to workspace detail (sidebar is visible on desktop)
      await page.goto(`/workspaces/${ws.id}`);
      await pauseBeforeAction(page, testInfo);

      // Wait for queue widget to become visible (polling refreshes every 10s, may need to wait)
      const queueWidget = page.locator('[data-testid="queue-widget"]');
      await expect(queueWidget).toBeVisible({ timeout: 15_000 });

      // Widget should show the task title
      const currentTask = queueWidget.locator('[data-testid="queue-current-task"]');
      await expect(currentTask).toBeVisible();
      await expect(currentTask).toContainText(sharedTaskTitle);

      // Widget should show the running status
      const statusLine = queueWidget.locator('[data-testid="queue-status"]');
      await expect(statusLine).toContainText('running');

      const state = await getQueue(request);
      expect(state.running?.taskId).toBe(sharedTaskId);
    });

    test('sending a chat message pauses the queue and the widget reflects it, then auto-resumes', async ({
      page,
      request,
    }, testInfo) => {
      await page.clock.install();
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const queueWidget = page.locator('[data-testid="queue-widget"]');
      const statusLine = queueWidget.locator('[data-testid="queue-status"]');
      await expect(queueWidget).toBeVisible({ timeout: 15_000 });
      await expect(statusLine).toContainText('running');

      // Drive this through the real chat UI, not a background API call —
      // this is the video-recorded demonstration that a chat message is
      // what's pausing the queue, so the pause needs to visibly follow from
      // typing and sending, not happen off-screen. We don't wait for an
      // assistant response (irrelevant here, and may not even resolve
      // without a configured LLM provider) — only for the send itself.
      await page.locator('[data-slot="textarea"]').fill('hello from e2e');
      await page.locator('button[aria-label="Send message"]').click();

      // The scheduler pauses synchronously when the chat request lands —
      // wait for that server-side fact before fast-forwarding the widget's
      // poll, so we're not racing the request itself.
      await expect.poll(async () => (await getQueue(request)).paused, { timeout: 5000 }).toBe(true);

      await page.clock.fastForward(WIDGET_POLL_FAST_FORWARD_MS);
      await expect(statusLine).toContainText('Paused — chat active');
      // A paused (re-queued) task keeps surfacing as the current task rather
      // than blanking the widget out mid-pause — see thread-sidebar.tsx.
      await expect(queueWidget.locator('[data-testid="queue-current-task"]')).toContainText(
        sharedTaskTitle,
      );

      // Server-side auto-resume — bounded wait, not a fixed sleep.
      await expect
        .poll(async () => (await getQueue(request)).paused, { timeout: IDLE_RESUME_MS + 5000 })
        .toBe(false);
      await expect
        .poll(async () => (await getQueue(request)).running?.taskId, { timeout: 5000 })
        .toBe(sharedTaskId);

      await page.clock.fastForward(WIDGET_POLL_FAST_FORWARD_MS);
      await expect(statusLine).toContainText('running');
    });

    test('a second chat message resets the idle-resume timer', async ({ request }) => {
      sendChatFireAndForget(request, 'first message');
      await expect.poll(async () => (await getQueue(request)).paused, { timeout: 5000 }).toBe(true);

      // Send the second message partway through the idle window so it lands
      // well before the first message's deadline.
      await new Promise((r) => setTimeout(r, IDLE_RESUME_MS / 2));
      sendChatFireAndForget(request, 'second message, resets the timer');
      await expect.poll(async () => (await getQueue(request)).paused, { timeout: 5000 }).toBe(true);

      // Past the *first* message's original deadline, but comfortably before
      // the reset deadline — this has to be a fixed wait: we're asserting
      // something hasn't happened yet, which `expect.poll` (eventual truth)
      // can't express.
      await new Promise((r) => setTimeout(r, IDLE_RESUME_MS / 2 + 500));
      expect((await getQueue(request)).paused).toBe(true);

      // Now past the reset deadline — should resume on its own.
      await expect
        .poll(async () => (await getQueue(request)).paused, { timeout: IDLE_RESUME_MS })
        .toBe(false);
      await expect
        .poll(async () => (await getQueue(request)).running?.taskId, { timeout: 5000 })
        .toBe(sharedTaskId);
    });

    test('a task enqueued while paused stays pending for the duration of the pause', async ({
      request,
    }) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'queue-pause-enqueue-ws', location: '/tmp/queue-pause-enqueue-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      sendChatFireAndForget(request, 'pause while a second task gets enqueued');
      await expect.poll(async () => (await getQueue(request)).paused, { timeout: 5000 }).toBe(true);

      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'Enqueued-while-paused task', workspaceId: ws.id, assignedTo: 'agent' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();
      const enqRes = await request.post(`/api/v1/tasks/${task.id}/enqueue`);
      expect(enqRes.status()).toBe(201);

      // The scheduler is event-driven (wake() is called on enqueue too) —
      // give it a moment to (incorrectly, if this regresses) act on the new
      // task, then confirm it stayed put: still paused, and the new entry
      // never left 'pending' to start running underneath the chat turn.
      await new Promise((r) => setTimeout(r, 500));
      const midState = await getQueue(request);
      expect(midState.paused).toBe(true);
      // While paused, the previously-running shared task is re-queued as
      // 'paused' rather than 'running' — see pause() in task-scheduler.ts —
      // so `running` is null for the whole pause, not just for the new task.
      expect(midState.running).toBeNull();
      expect(midState.queue.find((e) => e.taskId === sharedTaskId)?.status).toBe('paused');
      expect(midState.queue.find((e) => e.taskId === task.id)?.status).toBe('pending');

      // Let the idle timer fire; the scheduler unpauses and re-runs whatever
      // was paused (sharedTaskId, since it was already running and keeps its
      // queue position) — the new task, further back in the queue, correctly
      // stays pending rather than being dropped or left paused.
      await expect
        .poll(async () => (await getQueue(request)).paused, { timeout: IDLE_RESUME_MS + 5000 })
        .toBe(false);
      const finalState = await getQueue(request);
      expect(finalState.running?.taskId).toBe(sharedTaskId);
      expect(finalState.queue.find((e) => e.taskId === task.id)?.status).toBe('pending');
    });

    test('answering a HITL prompt pauses and auto-resumes the queue like a plain send', async ({
      request,
    }) => {
      // resumeChatToSse (the /hitl entry point) has its own
      // pause()/scheduleResume() wiring, independent of the plain-send path
      // exercised above — this proves it works the same way, without needing
      // a live LLM or a genuine prior HITL prompt (an unresolvable promptId
      // is handled gracefully inside resumeChatToSse; see scheduler.ts).
      sendHitlResumeFireAndForget(request);
      await expect.poll(async () => (await getQueue(request)).paused, { timeout: 5000 }).toBe(true);

      await expect
        .poll(async () => (await getQueue(request)).paused, { timeout: IDLE_RESUME_MS + 5000 })
        .toBe(false);
      await expect
        .poll(async () => (await getQueue(request)).running?.taskId, { timeout: 5000 })
        .toBe(sharedTaskId);
    });
  },
);
