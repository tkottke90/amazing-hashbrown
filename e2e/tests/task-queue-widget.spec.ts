import { test, expect } from '@playwright/test';
import { suiteAnnotations } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
import { WIDGET_POLL_FAST_FORWARD_MS, getQueue } from '../lib/scheduler.js';

import { TestSuite } from '@tkottke90/playwrite-test-runner';

const suite: TestSuite = {
  id: 7,
  name: 'Task Queue Widget',
  purpose:
    'Ensure the queue widget shows current task name and status after enqueue, and that the enqueue/cancel/take-over rules (R14 and friends) work correctly',
  tag: ['@user-workflow', '@functional'],
  steps: [
    {
      tag: [],
      action: 'Create workspace and task via API, then enqueue it',
      expectedOutcome: 'Queue widget is visible with the task title and "running" status',
      test: () => {},
    },
    {
      tag: ['@functional'],
      action: 'Set an agent-assigned task to Ready via the task drawer',
      expectedOutcome: 'The task is enqueued (R14) without a separate /enqueue call',
      test: () => {},
    },
    {
      tag: ['@functional'],
      action: "Patch a user-assigned task's status to Ready via the API",
      expectedOutcome: 'The task is NOT enqueued — R14 only applies to agent-assigned tasks',
      test: () => {},
    },
    {
      tag: ['@functional'],
      action: 'POST /:id/cancel on a task that is ready but not yet running',
      expectedOutcome: 'The task is cancelled synchronously and drops out of the queue',
      test: () => {},
    },
    {
      tag: ['@functional'],
      action: 'POST /:id/take-over on a task that is ready but not yet running',
      expectedOutcome:
        'The task is reassigned to the user (status pending) synchronously and drops out of the queue',
      test: () => {},
    },
  ],
};

// The scheduler enforces one running task per scope (workspace/Inbox), not
// globally (issue #160) — sharedTaskId occupies sharedWorkspaceId's running
// slot for the whole file (the noop executor never resolves), and the
// cancel/take-over tests below deliberately enqueue their own task into that
// *same* workspace so it's reliably blocked behind sharedTaskId rather than
// immediately dequeuing into a free scope of its own. Serial mode keeps the
// tests from interleaving with each other under Playwright's default
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
    let sharedWorkspaceId: string;
    const sharedTaskTitle = 'Queued task title';

    test('queue widget appears and shows task when enqueued', async ({
      page,
      request,
    }, testInfo) => {
      // Create the workspace via API — plain setup, not the thing this test
      // demonstrates. Navigate to it *before* the task exists, so the actual
      // enqueue happens while the page is already loaded and watching —
      // otherwise the video just shows a static "already there" widget with
      // nothing visibly causing it, which doesn't demonstrate "becomes
      // visible when a task is enqueued" at all.
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'queue-widget-ws',
          locationRoot: 'temporary',
          directoryName: 'queue-widget-ws',
        },
      });
      expect(wsRes.status(), 'Expect the workspace to be created').toBe(201);
      const ws = await wsRes.json();
      sharedWorkspaceId = ws.id;

      await page.clock.install();
      await page.goto(`/workspaces/${ws.id}`);
      await pauseBeforeAction(page, testInfo);

      const queueWidget = page.locator('[data-testid="queue-widget"]');
      await expect(queueWidget, 'Expect the queue widget to be hidden').not.toBeVisible();

      // Create and enqueue the task now, with the page already watching.
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: sharedTaskTitle, workspaceId: ws.id, assignedTo: 'agent' },
      });
      expect(taskRes.status(), 'Expect the task to be created successfully').toBe(201);
      const task = await taskRes.json();
      sharedTaskId = task.id;

      const enqRes = await request.post(`/api/v1/tasks/${task.id}/enqueue`);
      expect(enqRes.status(), 'Expect the task to be enqueued').toBe(201);

      // Widget polls every 10s (thread-sidebar.tsx) — fast-forward the
      // browser's virtual clock rather than waiting for real time to pass.
      await page.clock.fastForward(WIDGET_POLL_FAST_FORWARD_MS);

      // Widget should show the task title
      const currentTask = queueWidget.locator('[data-testid="queue-current-task"]');
      await expect(currentTask).toBeVisible();
      await expect(currentTask).toContainText(sharedTaskTitle);

      // Widget should show the running status
      const statusLine = queueWidget.locator('[data-testid="queue-status"]');
      await expect(statusLine).toContainText('running');

      const state = await getQueue(request);
      expect(state.running.some((r) => r.taskId === sharedTaskId)).toBe(true);
    });

    test('setting an agent-assigned task to Ready via the drawer enqueues it (R14)', async ({
      page,
      request,
    }, testInfo) => {
      // Independent workspace/task — doesn't touch sharedTaskId, since this
      // proves the implicit enqueue-via-status=ready path works through the
      // real UI, distinct from the direct POST /:id/enqueue path the first
      // test in this file already covers.
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'queue-ready-ui-ws',
          locationRoot: 'temporary',
          directoryName: 'queue-ready-ui-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'Ready-via-drawer task', workspaceId: ws.id, assignedTo: 'agent' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();

      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      const taskCard = page
        .locator('[data-column="pending"]')
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'Ready-via-drawer task' });
      await expect(taskCard).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await taskCard.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      await drawer.locator('[data-testid="task-status-select"]').selectOption('ready');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      const state = await getQueue(request);
      expect(
        state.queue.some((e) => e.taskId === task.id) ||
          state.running.some((r) => r.taskId === task.id),
      ).toBe(true);
    });

    test('patching a user-assigned task to Ready does NOT enqueue it (R14 negative case)', async ({
      request,
    }) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'queue-ready-user-ws',
          locationRoot: 'temporary',
          directoryName: 'queue-ready-user-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'User-assigned ready task', workspaceId: ws.id, assignedTo: 'user' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();

      const patchRes = await request.patch(`/api/v1/tasks/${task.id}`, {
        data: { status: 'ready' },
      });
      expect(patchRes.status()).toBe(200);

      const state = await getQueue(request);
      expect(state.queue.some((e) => e.taskId === task.id)).toBe(false);
      expect(state.running.some((r) => r.taskId === task.id)).toBe(false);
    });

    // The two tests below cover only the synchronous ready-task branches of
    // cancelTaskHandler/takeOverTaskHandler (api/src/routes/v1/tasks.handlers.ts)
    // — the scheduler now serializes per scope rather than globally (#160),
    // so the tasks here are deliberately enqueued into sharedWorkspaceId
    // (already occupied by sharedTaskId, and the noop executor never
    // resolves) to reliably stay 'ready'/pending rather than being dequeued
    // out from under the test. The abort-branch behavior (cancel/take-over
    // while actually running) needs a real or fake agent run to interrupt,
    // which this e2e harness's noop executor can't provide — that's covered
    // instead by task-execution.test.ts's fake-agent unit tests, which can
    // control timing exactly.
    test('cancelling a ready (not-yet-running) task removes it from the queue', async ({
      request,
    }) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: {
          title: 'Cancel-me-while-ready task',
          workspaceId: sharedWorkspaceId,
          assignedTo: 'agent',
        },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();
      const enqRes = await request.post(`/api/v1/tasks/${task.id}/enqueue`);
      expect(enqRes.status()).toBe(201);

      // Confirms the setup assumption: sharedTaskId is still occupying
      // sharedWorkspaceId's running slot, so this task is genuinely 'ready',
      // not dequeued.
      const before = await getQueue(request);
      expect(before.running.some((r) => r.taskId === sharedTaskId)).toBe(true);
      expect(before.queue.find((e) => e.taskId === task.id)?.status).toBe('pending');

      const cancelRes = await request.post(`/api/v1/tasks/${task.id}/cancel`);
      expect(cancelRes.status()).toBe(200);
      const cancelled = await cancelRes.json();
      expect(cancelled.status).toBe('cancelled');

      const after = await getQueue(request);
      expect(after.queue.some((e) => e.taskId === task.id)).toBe(false);
      const fetched = await (await request.get(`/api/v1/tasks/${task.id}`)).json();
      expect(fetched.status).toBe('cancelled');
    });

    test('taking over a ready task reassigns it to the user and drops it from the queue', async ({
      request,
    }) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: {
          title: 'Take-over-me-while-ready task',
          workspaceId: sharedWorkspaceId,
          assignedTo: 'agent',
        },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();
      const enqRes = await request.post(`/api/v1/tasks/${task.id}/enqueue`);
      expect(enqRes.status()).toBe(201);

      const before = await getQueue(request);
      expect(before.running.some((r) => r.taskId === sharedTaskId)).toBe(true);
      expect(before.queue.find((e) => e.taskId === task.id)?.status).toBe('pending');

      const takeOverRes = await request.post(`/api/v1/tasks/${task.id}/take-over`);
      expect(takeOverRes.status()).toBe(200);
      const takenOver = await takeOverRes.json();
      expect(takenOver.status).toBe('pending');
      expect(takenOver.assignedTo).toBe('user');

      const after = await getQueue(request);
      expect(after.queue.some((e) => e.taskId === task.id)).toBe(false);
    });
  },
);
