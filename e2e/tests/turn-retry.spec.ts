import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
import { IDLE_RESUME_MS, getQueue } from '../lib/scheduler.js';

const suite: TestSuite = {
  id: 9,
  name: 'Turn Retry',
  description:
    'Verifies a failed turn renders an error state with a Retry action, retry recovers, the retry pauses/auto-resumes the background task queue (issue #68), and the show-failed-attempts toggle reveals/hides the superseded attempt',
  purpose: 'Ensure turn failures are visible and recoverable instead of silently vanishing',
  tags: ['@user-workflow', '@llm'],
  steps: [
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Send a message with the send request forced to fail (bad provider override)',
      expectedOutcome: 'An error bubble with a Retry button appears',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Click Retry',
      expectedOutcome:
        "The turn resolves successfully in place; the task queue pauses when Retry is clicked and auto-resumes after the idle delay — retryChatToSse has the same pause()/scheduleResume() wiring as a plain send, exercised here with a real retryable turn (task-queue-widget.spec.ts covers plain send and HITL resume without needing a live LLM; retry's route rejects outright when there's no retryable turn, so it can only be exercised end-to-end here)",
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Reload, then toggle "Show failed attempts" on and off',
      expectedOutcome:
        'The superseded error bubble appears when the toggle is on and is hidden when it is off, while the successful retry always stays visible',
      test: () => {},
    },
  ],
};

async function forceNextSendToFail(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/v1/chat/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (!/\/api\/v1\/chat\/[^/]+$/.test(url.pathname)) {
      // Not the plain send endpoint (e.g. /retry, /hitl) — pass through untouched.
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({ ...body, provider: 'e2e-nonexistent-provider' }),
    });
  });
}

test.describe(
  '@user-workflow @llm',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('failed send shows an error bubble with Retry, and retry recovers', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/');
      await forceNextSendToFail(page);

      const message = `Retry check ${Date.now()}`;
      await page.locator('[data-slot="textarea"]').fill(message);
      await page.locator('button[aria-label="Send message"]').click();

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(assistantMsg.getByText('Something went wrong. Please try again.')).toBeVisible({
        timeout: 30_000,
      });

      const retryBtn = assistantMsg.locator('button[aria-label="Retry"]');
      await expect(retryBtn).toBeVisible();

      // The retry request goes to /retry, which is left unmodified by
      // forceNextSendToFail, so it hits the real (working) default provider.
      await pauseBeforeAction(page, testInfo);
      await retryBtn.click();

      // retryChatToSse pauses the background task queue exactly like a plain
      // send (issue #68) — this is the one place that's exercisable, since
      // POST /retry's own route handler rejects outright (400, before ever
      // calling retryChatToSse/pause()) when there's no genuine retryable
      // turn to point at, and producing one needs a real failed model call —
      // see task-queue-widget.spec.ts for plain-send and HITL-resume
      // coverage of the same pause()/scheduleResume() wiring without a live
      // LLM.
      await expect.poll(async () => (await getQueue(request)).paused, { timeout: 5000 }).toBe(true);

      await expect(
        assistantMsg.getByText('Something went wrong. Please try again.'),
      ).not.toBeVisible({
        timeout: 30_000,
      });
      await expect(assistantMsg.locator('.animate-bounce').first()).not.toBeVisible({
        timeout: 30_000,
      });

      // Auto-resumes on its own after the idle delay, same as any other chat
      // entry point.
      await expect
        .poll(async () => (await getQueue(request)).paused, { timeout: IDLE_RESUME_MS + 5000 })
        .toBe(false);
    });

    test('show-failed-attempts toggle reveals and hides the superseded error after reload', async ({
      page,
    }, testInfo) => {
      await page.goto('/');
      await forceNextSendToFail(page);

      const message = `Toggle check ${Date.now()}`;
      await page.locator('[data-slot="textarea"]').fill(message);
      await page.locator('button[aria-label="Send message"]').click();

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(assistantMsg.getByText('Something went wrong. Please try again.')).toBeVisible({
        timeout: 30_000,
      });
      await assistantMsg.locator('button[aria-label="Retry"]').click();
      await expect(assistantMsg.locator('.animate-bounce').first()).not.toBeVisible({
        timeout: 30_000,
      });

      // Live session state updates the same bubble in place — the superseded
      // failed row only exists once we hydrate from the server.
      await page.reload();

      await expect(page.getByText('Something went wrong. Please try again.')).not.toBeVisible();

      const toggle = page.getByRole('switch');
      await pauseBeforeAction(page, testInfo);
      await toggle.click();

      await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('[data-testid="assistant-message"]').last()).not.toContainText(
        'Something went wrong',
      );

      await pauseBeforeAction(page, testInfo);
      await toggle.click();
      await expect(page.getByText('Something went wrong. Please try again.')).not.toBeVisible();
    });
  },
);
