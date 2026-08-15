import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 8,
  name: 'Task Plan Field',
  description: 'Verifies adding plan steps to a task and persisting checked state',
  purpose: 'Ensure plan steps are created, checked, and persisted after drawer close/reopen',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Create a workspace and open the new task drawer',
      expectedOutcome: 'Task drawer is open with the Plan section visible',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add two plan steps and create the task',
      expectedOutcome: 'Task is created with two unchecked plan steps',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Check the first step checkbox',
      expectedOutcome: 'Checkbox is checked and step text has line-through',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Close and reopen the task drawer',
      expectedOutcome: 'Checked state persisted after reopening',
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
    test('plan steps are created and persisted with checked state', async ({
      page,
      request,
    }, testInfo) => {
      // Create workspace via API
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'plan-field-ws', location: '/tmp/plan-field-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Open task creation drawer
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Add task' }).click();

      const drawer = page.locator('[role="dialog"]');
      await expect(drawer).toBeVisible();

      // Fill in title
      await drawer.locator('input[placeholder="Task title"]').fill('Plan test task');

      // Add first step
      await drawer.getByRole('button', { name: 'Add a step' }).click();
      const stepInputs = drawer.locator('[data-testid="plan-step"] input[type="text"]');
      await stepInputs.first().fill('Install dependencies');

      // Add second step
      await drawer.getByRole('button', { name: 'Add a step' }).click();
      await stepInputs.nth(1).fill('Run migration');

      // Create the task
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create task' }).click();

      // Task card should appear in Pending column
      const pendingColumn = page.locator('[data-column="pending"]');
      const taskCard = pendingColumn
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'Plan test task' });
      await expect(taskCard).toBeVisible();

      // Open the task drawer by clicking the card
      await taskCard.click();

      // Verify plan section with two steps
      const planSection = page.locator('[data-testid="task-plan"]');
      await expect(planSection).toBeVisible();

      const planSteps = planSection.locator('[data-testid="plan-step"]');
      await expect(planSteps).toHaveCount(2);

      // Both steps should be unchecked
      await expect(planSteps.nth(0)).toHaveAttribute('data-done', 'false');
      await expect(planSteps.nth(1)).toHaveAttribute('data-done', 'false');

      // Check the first step
      await pauseBeforeAction(page, testInfo);
      const firstCheckbox = planSteps.nth(0).locator('[data-testid="plan-step-checkbox"]');
      await firstCheckbox.click();

      // First step should now be checked with line-through
      await expect(planSteps.nth(0)).toHaveAttribute('data-done', 'true');
      await expect(firstCheckbox).toBeChecked();

      // Close the drawer
      await page.locator('[role="dialog"]').getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('[role="dialog"]')).not.toBeVisible();

      // Reopen by clicking the task card again
      await pauseBeforeAction(page, testInfo);
      await taskCard.click();

      // Verify the checked state persisted
      const reopenedPlan = page.locator('[data-testid="task-plan"]');
      await expect(reopenedPlan).toBeVisible();

      const reopenedSteps = reopenedPlan.locator('[data-testid="plan-step"]');
      await expect(reopenedSteps).toHaveCount(2);
      await expect(reopenedSteps.nth(0)).toHaveAttribute('data-done', 'true');
      await expect(
        reopenedSteps.nth(0).locator('[data-testid="plan-step-checkbox"]'),
      ).toBeChecked();
      await expect(reopenedSteps.nth(1)).toHaveAttribute('data-done', 'false');
    });
  },
);
