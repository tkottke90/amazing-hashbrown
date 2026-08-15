import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 6,
  name: 'Task Kanban',
  description: 'Verifies creating a workspace, adding a task, and moving it between Kanban columns',
  purpose: 'Ensure tasks appear in the correct column and move when status changes',
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
      expectedOutcome: 'Task card appears in the Pending column',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Change the task status to Running via API',
      expectedOutcome: 'Task card moves from Pending to Running column',
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
    test('task appears in Pending column after creation', async ({ page, request }, testInfo) => {
      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      // Create workspace via API for speed
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'kanban-test-ws', location: '/tmp/kanban-test-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      // Navigate to workspace Tasks tab
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Add task via UI
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Add task' }).click();

      const drawer = page.locator('[role="dialog"]');
      await expect(drawer).toBeVisible();
      await drawer.locator('input[placeholder="Task title"]').fill('My kanban task');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create task' }).click();

      // Task card should appear in the Pending column
      const pendingColumn = page.locator('[data-column="pending"]');
      await expect(pendingColumn).toBeVisible();
      const card = pendingColumn.locator('[data-testid="task-card"]').filter({ hasText: 'My kanban task' });
      await expect(card).toBeVisible();
    });

    test('task moves to Running column when status changes', async ({ page, request }, testInfo) => {
      await page.goto('/workspaces');

      // Create workspace and task via API
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'kanban-move-ws', location: '/tmp/kanban-move-ws' },
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

      // Verify task is in Pending column
      const pendingColumn = page.locator('[data-column="pending"]');
      await expect(pendingColumn.locator('[data-task-id]').filter({ hasText: 'Moveable task' })).toBeVisible();

      // Change status to running via API
      const patchRes = await request.patch(`/api/v1/tasks/${task.id}`, {
        data: { status: 'running' },
      });
      expect(patchRes.status()).toBe(200);

      // Reload to pick up the new status
      await page.reload();
      await page.getByRole('button', { name: /tasks/i }).click();

      await pauseBeforeAction(page, testInfo);

      // Task should now be in Running column
      const runningColumn = page.locator('[data-column="running"]');
      await expect(runningColumn).toBeVisible();
      await expect(runningColumn.locator('[data-testid="task-card"]').filter({ hasText: 'Moveable task' })).toBeVisible();

      // And not in Pending column
      await expect(pendingColumn.locator('[data-testid="task-card"]').filter({ hasText: 'Moveable task' })).not.toBeVisible();
    });
  },
);
