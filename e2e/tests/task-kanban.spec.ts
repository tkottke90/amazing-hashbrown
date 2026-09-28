import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 6,
  name: 'Task Kanban',
  description:
    'Verifies creating a workspace, adding a task, and seeing it move between Kanban lanes',
  purpose:
    'Ensure tasks appear in the correct lane, with their exact status, and move when status changes',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Navigate to /workspaces and create a workspace',
      expectedOutcome: 'Workspace is created and listed in the table',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Navigate to the workspace Tasks tab and add a task',
      expectedOutcome: 'Task card appears in the Backlog lane',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Change the task status to Running via API',
      expectedOutcome: 'Task card moves from Backlog to Queue, badged Running',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create a workspace task on a repeating schedule',
      expectedOutcome: 'Its card sits in the Scheduled lane and shows when it runs next',
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
    test('task appears in the Backlog lane after creation', async ({ page, request }, testInfo) => {
      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      // Create workspace via API for speed
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'kanban-test-ws',
          locationRoot: 'temporary',
          directoryName: 'kanban-test-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      // Navigate to workspace Tasks tab
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Add task via UI
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Add task' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      await drawer.locator('input[placeholder="Task title"]').fill('My kanban task');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create task' }).click();

      // Task card should appear in the Backlog lane
      const backlogLane = page.locator('[data-column="backlog"]');
      await expect(backlogLane).toBeVisible();
      const card = backlogLane
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'My kanban task' });
      await expect(card).toBeVisible();
    });

    test('task moves to the Queue lane, badged Running, when status changes', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/workspaces');

      // Create workspace and task via API
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'kanban-move-ws',
          locationRoot: 'temporary',
          directoryName: 'kanban-move-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'Moveable task', workspaceId: ws.id, assignedTo: 'agent' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();

      // Navigate to workspace Tasks tab
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Verify task is in the Backlog lane
      const backlogLane = page.locator('[data-column="backlog"]');
      await expect(
        backlogLane.locator('[data-task-id]').filter({ hasText: 'Moveable task' }),
      ).toBeVisible();

      // Change status to running via API
      const patchRes = await request.patch(`/api/v1/tasks/${task.id}`, {
        data: { status: 'running' },
      });
      expect(patchRes.status()).toBe(200);

      // Reload to pick up the new status
      await page.reload();
      await page.getByRole('button', { name: /tasks/i }).click();

      await pauseBeforeAction(page, testInfo);

      // Task should now be in the Queue lane, with its exact status on the card
      const queueLane = page.locator('[data-column="queue"]');
      await expect(queueLane).toBeVisible();
      const runningCard = queueLane
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'Moveable task' });
      await expect(runningCard).toBeVisible();
      await expect(runningCard).toHaveAttribute('data-status', 'running');

      // And not in the Backlog
      await expect(
        backlogLane.locator('[data-testid="task-card"]').filter({ hasText: 'Moveable task' }),
      ).not.toBeVisible();
    });

    test('a scheduled task sits in the Scheduled lane with its next run', async ({
      page,
      request,
    }, testInfo) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'kanban-scheduled-ws',
          locationRoot: 'temporary',
          directoryName: 'kanban-scheduled-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      // Jan 1 only — never fires during the run.
      const taskRes = await request.post('/api/v1/tasks', {
        data: {
          title: 'Yearly review',
          workspaceId: ws.id,
          assignedTo: 'agent',
          triggerType: 'cron_repeat',
          triggerConfig: { expression: '0 9 1 1 *', timezone: 'UTC' },
        },
      });
      expect(taskRes.status()).toBe(201);
      expect((await taskRes.json()).status).toBe('scheduled');

      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();
      await pauseBeforeAction(page, testInfo);

      const card = page
        .locator('[data-column="scheduled"] [data-testid="task-card"]')
        .filter({ hasText: 'Yearly review' });
      await expect(card).toBeVisible();
      await expect(card.locator('[data-testid="task-card-schedule"]')).toContainText('next:');
    });
  },
);
