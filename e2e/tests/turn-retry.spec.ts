import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 9,
  name: 'Turn Retry',
  description:
    'Verifies a failed turn renders an error state with a Retry action, retry starts a new bubble while collapsing the failed one (issue #65) rather than hiding it, and the collapsed attempt survives a reload with the expand-all toggle controlling its default state',
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
        'The failed bubble collapses to a click-to-expand row and a new bubble streams the successful retry below it',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Reload, then toggle "Expand failed attempts" on and off',
      expectedOutcome:
        'The collapsed failed attempt is still present after reload (not hidden); the toggle expands it (and any other superseded row) in place, and collapses it again when turned off',
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

      // The failed bubble collapses immediately (live, no reload needed) —
      // it is not silently discarded (issue #65's error-content-loss half).
      const collapsedRow = page.getByText('Attempt failed — click to view');
      await expect(collapsedRow).toBeVisible({ timeout: 10_000 });

      // `.last()` re-resolves against the current DOM — now the new retry
      // bubble appended after the collapsed row, not the original one.
      await expect(
        assistantMsg.getByText('Something went wrong. Please try again.'),
      ).not.toBeVisible({
        timeout: 30_000,
      });
      await expect(assistantMsg.locator('.animate-bounce').first()).not.toBeVisible({
        timeout: 30_000,
      });

      // The collapsed row still expands on click, showing the original
      // (content-less, in this forced-bad-provider scenario) error state.
      await pauseBeforeAction(page, testInfo);
      await collapsedRow.click();
      await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible();
      await expect(page.locator('button[aria-label="Retry"]')).toHaveCount(0);
    });

    test('a collapsed failed attempt survives reload, and the expand-all toggle controls its default state', async ({
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
      await expect(page.getByText('Attempt failed — click to view')).toBeVisible({
        timeout: 10_000,
      });

      await page.reload();

      // Reload no longer hides the superseded row entirely — it's still
      // there, just collapsed by default (issue #65).
      await expect(page.getByText('Attempt failed — click to view')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText('Something went wrong. Please try again.')).not.toBeVisible();

      // The repurposed toggle now expands every superseded row at once,
      // rather than revealing/hiding them.
      const toggle = page.getByRole('switch');
      await pauseBeforeAction(page, testInfo);
      await toggle.click();

      await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText('Attempt failed — click to view')).not.toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await toggle.click();
      await expect(page.getByText('Something went wrong. Please try again.')).not.toBeVisible();
      await expect(page.getByText('Attempt failed — click to view')).toBeVisible();
    });
  },
);
