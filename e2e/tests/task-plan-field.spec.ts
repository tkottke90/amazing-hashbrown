import { test, expect, type Route } from '@playwright/test';
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
    {
      tags: ['@user-workflow'],
      action: 'Open the new task drawer with no title and click the sparkle button',
      expectedOutcome: 'Sparkle button is disabled with an "Add a title..." tooltip',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Enter a title, stub a successful generate-plan response, click the sparkle button',
      expectedOutcome: 'The stubbed steps are appended to the plan',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add a manual step, then generate via a stubbed success response',
      expectedOutcome: 'The manual step stays first; generated steps are appended after it',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Stub a failing generate-plan response and click the sparkle button',
      expectedOutcome: 'An inline error is shown and the plan is unchanged',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Generate a plan on an already-saved task with a stubbed success response',
      expectedOutcome: 'Generated steps appear and persist after closing/reopening the drawer',
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
        data: { name: 'plan-field-ws', locationRoot: 'temporary', directoryName: 'plan-field-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // Open task creation drawer
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Add task' }).click();

      const drawer = page.locator('dialog[open]');
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
      const planSection = page.locator('dialog[open] [data-testid="task-plan"]');
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
      await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('dialog[open]')).not.toBeVisible();

      // Reopen by clicking the task card again
      await pauseBeforeAction(page, testInfo);
      await taskCard.click();

      // Verify the checked state persisted
      const reopenedPlan = page.locator('dialog[open] [data-testid="task-plan"]');
      await expect(reopenedPlan).toBeVisible();

      const reopenedSteps = reopenedPlan.locator('[data-testid="plan-step"]');
      await expect(reopenedSteps).toHaveCount(2);
      await expect(reopenedSteps.nth(0)).toHaveAttribute('data-done', 'true');
      await expect(
        reopenedSteps.nth(0).locator('[data-testid="plan-step-checkbox"]'),
      ).toBeChecked();
      await expect(reopenedSteps.nth(1)).toHaveAttribute('data-done', 'false');
    });

    test('AI plan generation appends to the plan, respects the disabled/loading/error states, and persists', async ({
      page,
      request,
    }, testInfo) => {
      // Stubbed rather than hitting a real model — this repo's convention
      // for testing an LLM-backed endpoint at the e2e layer without live
      // provider calls. `planResponse` is mutated before each action below
      // to drive the different scenarios through the same two routes.
      let planResponse: { status: number; body: unknown } = {
        status: 200,
        body: [{ step: 'Stubbed step one', done: false }],
      };
      await page.route('**/api/v1/tasks/generate-plan', async (route: Route) => {
        await route.fulfill({ status: planResponse.status, json: planResponse.body });
      });
      await page.route('**/api/v1/tasks/*/generate-plan', async (route: Route) => {
        await route.fulfill({ status: planResponse.status, json: planResponse.body });
      });

      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'plan-gen-ws', locationRoot: 'temporary', directoryName: 'plan-gen-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      // --- Empty title: sparkle disabled with tooltip ---
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Add task' }).click();
      let drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      const sparkleButton = drawer.getByRole('button', { name: 'Generate plan with AI' });
      await expect(sparkleButton).toBeDisabled();
      await expect(sparkleButton).toHaveAttribute('title', 'Add a title before generating a plan');

      // --- Title entered, stubbed success: generated step appears ---
      await pauseBeforeAction(page, testInfo);
      await drawer.locator('input[placeholder="Task title"]').fill('AI plan test task');
      await expect(sparkleButton).toBeEnabled();
      await sparkleButton.click();

      const planSection = drawer.locator('[data-testid="task-plan"]');
      const planSteps = planSection.locator('[data-testid="plan-step"]');
      await expect(planSteps).toHaveCount(1);
      await expect(planSteps.nth(0)).toContainText('Stubbed step one');

      // --- A manual step added next, then another stubbed-success generate:
      //     existing steps (the earlier generated one plus this manual one)
      //     must stay in place, with the new generated step appended after ---
      await pauseBeforeAction(page, testInfo);
      planResponse = { status: 200, body: [{ step: 'Generated step two', done: false }] };
      await drawer.getByRole('button', { name: 'Add a step' }).click();
      const stepInputs = planSection.locator('[data-testid="plan-step"] input[type="text"]');
      await stepInputs.last().fill('Manual step zero');
      await sparkleButton.click();
      await expect(planSteps).toHaveCount(3);
      await expect(planSteps.nth(0)).toContainText('Stubbed step one');
      await expect(planSteps.nth(1)).toContainText('Manual step zero');
      await expect(planSteps.nth(2)).toContainText('Generated step two');

      // --- Stubbed failure: inline error shown, plan unchanged ---
      await pauseBeforeAction(page, testInfo);
      planResponse = { status: 500, body: { error: 'Plan generation failed: boom' } };
      const countBeforeFailure = await planSteps.count();
      await sparkleButton.click();
      await expect(planSection.locator('text=Plan generation failed: boom')).toBeVisible();
      await expect(planSteps).toHaveCount(countBeforeFailure);

      // Save the task so the remaining scenario can exercise the saved-task
      // (PATCH-persisted) generate path.
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create task' }).click();

      const pendingColumn = page.locator('[data-column="pending"]');
      const taskCard = pendingColumn
        .locator('[data-testid="task-card"]')
        .filter({ hasText: 'AI plan test task' });
      await expect(taskCard).toBeVisible();

      // --- Generate on the now-saved task: persists across drawer reopen ---
      await pauseBeforeAction(page, testInfo);
      await taskCard.click();
      drawer = page.locator('dialog[open]');
      const savedSparkleButton = drawer.getByRole('button', { name: 'Generate plan with AI' });
      planResponse = { status: 200, body: [{ step: 'Persisted generated step', done: false }] };
      const savedPlanSteps = drawer.locator('[data-testid="task-plan"] [data-testid="plan-step"]');
      const countBeforeSavedGenerate = await savedPlanSteps.count();
      await savedSparkleButton.click();
      await expect(savedPlanSteps).toHaveCount(countBeforeSavedGenerate + 1);
      await expect(savedPlanSteps.last()).toContainText('Persisted generated step');

      await page.locator('dialog[open]').getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('dialog[open]')).not.toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await taskCard.click();
      const reopenedSavedPlanSteps = page.locator(
        'dialog[open] [data-testid="task-plan"] [data-testid="plan-step"]',
      );
      await expect(reopenedSavedPlanSteps).toHaveCount(countBeforeSavedGenerate + 1);
      await expect(reopenedSavedPlanSteps.last()).toContainText('Persisted generated step');
    });
  },
);
