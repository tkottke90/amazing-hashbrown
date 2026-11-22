import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 64,
  name: 'Task Run Report',
  description:
    'Verifies the "Task Report" button in the task drawer opens the task\'s run-history HTML ' +
    'report in a new browser tab, and that it is absent for a brand-new, unsaved task',
  purpose:
    'Gives the same "generate a report" affordance for a multi-run autonomous task that the ' +
    'Thread Report button already gives for a single thread — ensure it wires up correctly and ' +
    "doesn't show up before there's anything to report on",
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Open an existing task\'s drawer and click the "Task Report" button',
      expectedOutcome: 'A new tab opens and displays the mocked HTML report content',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the new-task drawer (nothing saved yet)',
      expectedOutcome: 'No "Task Report" button is shown',
      test: () => {},
    },
  ],
};

const REPORT_HTML = `<!DOCTYPE html><html><body><h1>Task Run Report</h1></body></html>`;

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('task drawer: Task Report button opens HTML in a new tab', async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', {
        data: { title: 'e2e-task-report-task' },
      });
      expect(taskRes.status()).toBe(201);
      const taskId = ((await taskRes.json()) as { id: string }).id;

      try {
        // Registered on context (not page) so the popup page's navigation is
        // intercepted — same approach as thread-report.spec.ts.
        await page.context().route(`**/api/v1/tasks/${taskId}/report`, async (route: Route) => {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: REPORT_HTML,
          });
        });

        await page.goto('/inbox');
        const row = page
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-task-report-task' });
        await pauseBeforeAction(page, testInfo);
        await row.click();

        const newPagePromise = page.context().waitForEvent('page');
        await pauseBeforeAction(page, testInfo);
        await page.getByRole('button', { name: 'Task Report' }).click();
        const reportPage = await newPagePromise;

        await reportPage.waitForLoadState();
        await expect(reportPage.locator('h1')).toHaveText('Task Run Report');
      } finally {
        await request.delete(`/api/v1/tasks/${taskId}`);
      }
    });

    test('new-task drawer: no Task Report button for an unsaved task', async ({
      page,
    }, testInfo) => {
      await page.goto('/inbox');
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'New task' }).click();

      await expect(page.getByRole('button', { name: 'Task Report' })).toHaveCount(0);
    });
  },
);
