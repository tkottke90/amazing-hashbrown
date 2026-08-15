import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 7,
  name: 'Task Queue Widget',
  description: 'Verifies the sidebar Queue widget becomes visible when a task is enqueued',
  purpose: 'Ensure the queue widget shows current task name and status after enqueue',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Create workspace and task via API',
      expectedOutcome: 'Workspace and task exist in the system',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Enqueue the task via POST /api/v1/tasks/:id/enqueue',
      expectedOutcome: 'Task is added to the queue',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Check sidebar queue widget visibility',
      expectedOutcome: 'Queue widget is visible with the task title and status',
      test: () => {},
    },
  ],
};

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
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
        data: { title: 'Queued task title', workspaceId: ws.id, assignedTo: 'agent' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();

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
      await expect(currentTask).toContainText('Queued task title');

      // Widget should show a status line (running or pending)
      const statusLine = queueWidget.locator('[data-testid="queue-status"]');
      await expect(statusLine).toBeVisible();
      const statusText = await statusLine.textContent();
      expect(statusText).toBeTruthy();
    });
  },
);
