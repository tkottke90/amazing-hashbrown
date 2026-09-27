import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 17,
  name: 'Inbox & Task Management',
  description:
    'Verifies the /inbox page (tasks without a workspace), task description/outcome persistence, and status changes via the task drawer UI',
  purpose:
    'Ensure inbox routing, task creation from inbox, and the task drawer fields that are not covered by the Kanban suite are regression-tested',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Navigate to /inbox with no unassigned tasks',
      expectedOutcome: 'Empty state placeholder is visible',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create an inbox task with no due date via the New task button',
      expectedOutcome: 'Task appears in the No due date section',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create an inbox task with a future due date',
      expectedOutcome: 'Task appears in the Due soon section',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open an inbox task row to view its drawer',
      expectedOutcome: 'Task drawer opens with pre-filled title, description, and outcome',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Change task status to Done via the drawer status select',
      expectedOutcome: 'Task card moves from Pending column to Done column',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Change task status to Ready via the drawer status select',
      expectedOutcome: 'Task card moves from Pending column to Ready column',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Select Webhook as the trigger type, save, and reopen the task',
      expectedOutcome: 'Drawer shows a read-only webhook URL field and a Regenerate URL button',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click the webhook URL Copy button',
      expectedOutcome: 'The full webhook URL is written to the clipboard',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Regenerate URL and confirm the prompt',
      expectedOutcome: 'URL field shows a new token; the old token now 404s',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Regenerate URL and cancel the prompt',
      expectedOutcome: 'URL field is unchanged',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Select Webhook as the trigger type on a brand-new, unsaved task',
      expectedOutcome: 'A placeholder note is shown instead of a URL field',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'Select Scheduled (repeat), type a cron expression, time zone and limits, save, and reopen the task',
      expectedOutcome:
        'The preview reads the schedule back with upcoming times; after saving, the row shows the trigger and next run, and every field round-trips',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Type an invalid cron expression',
      expectedOutcome: 'The preview shows why it is invalid and Save stays disabled',
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
    test('inbox empty state is visible when there are no unassigned tasks', async ({
      page,
      request,
    }, testInfo) => {
      // Create a workspace task (has a workspaceId) — it should NOT appear in inbox
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-inbox-empty-ws',
          locationRoot: 'temporary',
          directoryName: 'e2e-inbox-empty-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await request.post('/api/v1/tasks', {
        data: { title: 'workspace-scoped task', workspaceId: ws.id },
      });

      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      // If there are no inbox tasks the empty state should be present.
      // Workspace-scoped tasks must not leak into inbox.
      const inboxRows = page.locator('[data-testid="inbox-task-row"]');
      const rowCount = await inboxRows.count();
      if (rowCount === 0) {
        await expect(page.locator('[data-testid="inbox-empty"]')).toBeVisible();
      }
      await expect(inboxRows.filter({ hasText: 'workspace-scoped task' })).toHaveCount(0);
    });

    test('task created from inbox New task button appears in No due date section', async ({
      page,
    }, testInfo) => {
      await page.goto('/inbox');

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'New task' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      await drawer.getByPlaceholder('Task title').fill('e2e-inbox-no-due-task');
      await drawer.getByPlaceholder('What needs to be done?').fill('Inbox description');
      await drawer.getByPlaceholder('A clear definition of done').fill('Inbox outcome');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create task' }).click();
      await expect(drawer).not.toBeVisible();

      // Task should appear in the No due date section
      const noDueSection = page.locator('[data-testid="inbox-no-due-date"]');
      await expect(noDueSection).toBeVisible();
      await expect(
        noDueSection
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-inbox-no-due-task' }),
      ).toBeVisible();
    });

    test('task with a due date appears in the Due soon section', async ({
      page,
      request,
    }, testInfo) => {
      // Create an inbox task with a due date via API
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dueAt = tomorrow.toISOString().slice(0, 10);

      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-inbox-due-task', dueAt },
      });
      expect(taskRes.status()).toBe(201);

      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      const dueSoonSection = page.locator('[data-testid="inbox-due-soon"]');
      await expect(dueSoonSection).toBeVisible();
      await expect(
        dueSoonSection
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-inbox-due-task' }),
      ).toBeVisible();
    });

    test('clicking an inbox task row opens its drawer with pre-filled description and outcome', async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: {
          title: 'e2e-inbox-detail-task',
          description: 'Pre-filled description',
          outcome: 'Pre-filled outcome',
        },
      });
      expect(taskRes.status()).toBe(201);

      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-testid="inbox-task-row"]')
        .filter({ hasText: 'e2e-inbox-detail-task' });
      await expect(row).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await row.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // All fields should be pre-filled from the created task
      await expect(drawer.getByPlaceholder('Task title')).toHaveValue('e2e-inbox-detail-task');
      await expect(drawer.getByPlaceholder('What needs to be done?')).toHaveValue(
        'Pre-filled description',
      );
      await expect(drawer.getByPlaceholder('A clear definition of done')).toHaveValue(
        'Pre-filled outcome',
      );
    });

    test('changing task status to Done via the drawer moves the card to the Done column', async ({
      page,
      request,
    }, testInfo) => {
      // Set up a workspace with a pending task
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-status-done-ws',
          locationRoot: 'temporary',
          directoryName: 'e2e-status-done-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await request.post('/api/v1/tasks', {
        data: { title: 'e2e-status-done-task', workspaceId: ws.id },
      });

      // Navigate to the Tasks tab
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Task should be in the Pending column
      const pendingColumn = page.locator('[data-column="pending"]');
      const taskCard = pendingColumn
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'e2e-status-done-task' });
      await expect(taskCard).toBeVisible();

      // Open the task drawer by clicking the card
      await pauseBeforeAction(page, testInfo);
      await taskCard.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // Change status to Done via the UI select
      await drawer.locator('[data-testid="task-status-select"]').selectOption('done');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      // Card should now be in the Done column
      const doneColumn = page.locator('[data-column="done"]');
      await expect(doneColumn).toBeVisible();
      await expect(
        doneColumn.locator('[data-testid="task-card"]').filter({ hasText: 'e2e-status-done-task' }),
      ).toBeVisible();

      // And no longer in Pending
      await expect(
        pendingColumn
          .locator('[data-testid="task-card"]')
          .filter({ hasText: 'e2e-status-done-task' }),
      ).not.toBeVisible();
    });

    test('changing task status to Ready via the drawer moves the card to the Ready column', async ({
      page,
      request,
    }, testInfo) => {
      // Set up a workspace with a pending, user-assigned task — this suite
      // exercises the drawer-driven status UI, not queue/enqueue behavior
      // (see task-queue-widget.spec.ts for the enqueue-on-ready assertions).
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-status-ready-ws',
          locationRoot: 'temporary',
          directoryName: 'e2e-status-ready-ws',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await request.post('/api/v1/tasks', {
        data: { title: 'e2e-status-ready-task', workspaceId: ws.id, assignedTo: 'user' },
      });

      // Navigate to the Tasks tab
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Task should be in the Pending column
      const pendingColumn = page.locator('[data-column="pending"]');
      const taskCard = pendingColumn
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'e2e-status-ready-task' });
      await expect(taskCard).toBeVisible();

      // Open the task drawer by clicking the card
      await pauseBeforeAction(page, testInfo);
      await taskCard.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // Change status to Ready via the UI select
      await drawer.locator('[data-testid="task-status-select"]').selectOption('ready');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      // Card should now be in the Ready column
      const readyColumn = page.locator('[data-column="ready"]');
      await expect(readyColumn).toBeVisible();
      await expect(
        readyColumn
          .locator('[data-testid="task-card"]')
          .filter({ hasText: 'e2e-status-ready-task' }),
      ).toBeVisible();

      // And no longer in Pending
      await expect(
        pendingColumn
          .locator('[data-testid="task-card"]')
          .filter({ hasText: 'e2e-status-ready-task' }),
      ).not.toBeVisible();
    });

    test('selecting Webhook as the trigger type shows the URL after reopening the task', async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-webhook-trigger-task' },
      });
      expect(taskRes.status()).toBe(201);

      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-testid="inbox-task-row"]')
        .filter({ hasText: 'e2e-webhook-trigger-task' });
      await row.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      await drawer.locator('[data-testid="task-trigger-type-select"]').selectOption('webhook');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      // Reopen — the drawer closes on every save, so the URL only appears
      // once the task is reloaded with its server-generated token.
      await row.click();
      const reopened = page.locator('dialog[open]');
      await expect(reopened).toBeVisible();
      await expect(reopened.locator('[data-testid="task-webhook-url"]')).toBeVisible();
      await expect(reopened.getByRole('button', { name: 'Regenerate URL' })).toBeVisible();
    });

    test('clicking Copy writes the webhook URL to the clipboard', async ({
      page,
      context,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-webhook-copy-task', triggerType: 'webhook' },
      });
      expect(taskRes.status()).toBe(201);

      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-testid="inbox-task-row"]')
        .filter({ hasText: 'e2e-webhook-copy-task' });
      await row.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      const urlField = drawer.locator('[data-testid="task-webhook-url"]');
      const url = await urlField.inputValue();

      await pauseBeforeAction(page, testInfo);
      await drawer.locator('[data-testid="task-webhook-copy-button"]').click();

      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(url);
    });

    test('regenerating the webhook URL after confirming invalidates the old token', async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-webhook-regenerate-task', triggerType: 'webhook' },
      });
      expect(taskRes.status()).toBe(201);

      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-testid="inbox-task-row"]')
        .filter({ hasText: 'e2e-webhook-regenerate-task' });
      await row.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      const urlField = drawer.locator('[data-testid="task-webhook-url"]');
      const oldUrl = await urlField.inputValue();

      page.on('dialog', (d) => d.accept());
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Regenerate URL' }).click();

      await expect(urlField).not.toHaveValue(oldUrl);

      const oldTokenRes = await request.post(new URL(oldUrl).pathname);
      expect(oldTokenRes.status()).toBe(404);
    });

    test('regenerating the webhook URL after cancelling leaves it unchanged', async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-webhook-regenerate-cancel-task', triggerType: 'webhook' },
      });
      expect(taskRes.status()).toBe(201);

      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-testid="inbox-task-row"]')
        .filter({ hasText: 'e2e-webhook-regenerate-cancel-task' });
      await row.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      const urlField = drawer.locator('[data-testid="task-webhook-url"]');
      const oldUrl = await urlField.inputValue();

      page.on('dialog', (d) => d.dismiss());
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Regenerate URL' }).click();

      await expect(urlField).toHaveValue(oldUrl);
    });

    test('selecting Webhook on a new, unsaved task shows a placeholder note instead of a URL', async ({
      page,
    }, testInfo) => {
      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'New task' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      await drawer.locator('[data-testid="task-trigger-type-select"]').selectOption('webhook');

      await expect(
        drawer.getByText('Webhook URL is generated once the task is saved.'),
      ).toBeVisible();
      await expect(drawer.locator('[data-testid="task-webhook-url"]')).not.toBeVisible();
    });

    test('a repeating schedule is previewed, saved, and round-trips every field', async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-cron-repeat-task', assignedTo: 'agent' },
      });
      expect(taskRes.status()).toBe(201);
      const task = await taskRes.json();

      await page.goto('/inbox');
      const row = page
        .locator('[data-testid="inbox-task-row"]')
        .filter({ hasText: 'e2e-cron-repeat-task' });
      await row.click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();
      await drawer.locator('[data-testid="task-trigger-type-select"]').selectOption('cron_repeat');

      // 09:00 on Jan 1 only — far enough out that it never fires during the run.
      await drawer.locator('[data-testid="cron-expression"]').fill('0 9 1 1 *');
      await drawer.locator('[data-testid="cron-timezone"]').fill('America/Chicago');
      await drawer.locator('[data-testid="cron-max-iterations"]').fill('5');
      await drawer.locator('[data-testid="cron-max-failures"]').fill('2');

      const preview = drawer.locator('[data-testid="cron-preview"]');
      await expect(preview).toHaveAttribute('data-state', 'valid');
      await expect(preview).toContainText('January');
      await expect(preview.locator('li')).toHaveCount(3);

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      await expect(row.locator('[data-testid="inbox-task-trigger"]')).toHaveText(
        'Scheduled (repeat)',
      );
      await expect(row).toContainText('next:');

      await row.click();
      const reopened = page.locator('dialog[open]');
      await expect(reopened.locator('[data-testid="cron-expression"]')).toHaveValue('0 9 1 1 *');
      await expect(reopened.locator('[data-testid="cron-timezone"]')).toHaveValue(
        'America/Chicago',
      );
      await expect(reopened.locator('[data-testid="cron-max-iterations"]')).toHaveValue('5');
      await expect(reopened.locator('[data-testid="cron-max-failures"]')).toHaveValue('2');
      await expect(reopened.locator('[data-testid="schedule-enabled"]')).toBeChecked();
      await expect(reopened.locator('[data-testid="schedule-next-run"]')).toBeVisible();

      await request.delete(`/api/v1/tasks/${task.id}`);
    });

    test('an invalid cron expression is explained and cannot be saved', async ({
      page,
    }, testInfo) => {
      await page.goto('/inbox');
      await page.getByRole('button', { name: 'New task' }).click();

      const drawer = page.locator('dialog[open]');
      await drawer.getByPlaceholder('Task title').fill('e2e-cron-invalid-task');
      await drawer.locator('[data-testid="task-trigger-type-select"]').selectOption('cron_repeat');
      await drawer.locator('[data-testid="cron-expression"]').fill('0 25 * * *');

      await pauseBeforeAction(page, testInfo);
      const preview = drawer.locator('[data-testid="cron-preview"]');
      await expect(preview).toHaveAttribute('data-state', 'invalid');
      await expect(drawer.getByRole('button', { name: 'Create task' })).toBeDisabled();
    });
  },
);
