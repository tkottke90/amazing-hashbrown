import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 26,
  name: 'Chat Error Classification',
  description:
    'Verifies a failed chat turn renders category-specific copy (billing, context length, ...) instead of the generic "Something went wrong" message, when the server classifies the failure — issue #146',
  purpose:
    'A user needs to tell a persistent failure (bad billing, conversation too long) apart from a transient one, so they know whether retrying is worth it',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        'Send a message whose response is staged (via a mocked SSE stream) as a stream_error event carrying a specific errorCategory',
      expectedOutcome:
        "The assistant bubble shows that category's own copy, not the generic fallback",
      test: () => {},
    },
  ],
};

// A hand-built SSE response body — per e2e/AGENTS.md, a static
// `data: {...}\n\n` string fulfills exactly like a real (if instant) stream
// to the client's parser. This stages a classified failure directly,
// without needing a live provider call to reliably reproduce one.
function buildStreamErrorBody(errorCategory: string, error: string): string {
  const events = [{ type: 'stream_error', error, errorCategory }];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function mockChatTurnError(
  page: import('@playwright/test').Page,
  errorCategory: string,
  error: string,
): Promise<void> {
  await page.route('**/api/v1/chat/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'POST' || !/\/api\/v1\/chat\/[^/]+$/.test(url.pathname)) {
      // Not the plain send endpoint (e.g. /retry, /hitl) — pass through untouched.
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildStreamErrorBody(errorCategory, error),
    });
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('a billing-classified failure shows the billing-specific message', async ({
      page,
    }, testInfo) => {
      await mockChatTurnError(
        page,
        'billing',
        'Your credit balance is too low to access the Anthropic API.',
      );
      await page.goto('/');

      await page.locator('[data-slot="textarea"]').fill('Hello');
      await pauseBeforeAction(page, testInfo);
      await page.locator('button[aria-label="Send message"]').click();

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(
        assistantMsg.getByText(
          "This provider account is out of credit or has a billing issue. Retrying won't help until that's resolved.",
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        assistantMsg.getByText('Something went wrong. Please try again.'),
      ).not.toBeVisible();
    });

    test('a context_length-classified failure shows the context-length-specific message', async ({
      page,
    }, testInfo) => {
      await mockChatTurnError(
        page,
        'context_length',
        "This model's maximum context length is 8192 tokens.",
      );
      await page.goto('/');

      await page.locator('[data-slot="textarea"]').fill('Hello');
      await pauseBeforeAction(page, testInfo);
      await page.locator('button[aria-label="Send message"]').click();

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(
        assistantMsg.getByText(
          "This conversation is too long for the model's context window. Try starting a new thread or shortening it.",
        ),
      ).toBeVisible({ timeout: 15_000 });
    });

    test('the raw provider message is available behind a "Show details" toggle', async ({
      page,
    }, testInfo) => {
      await mockChatTurnError(page, 'rate_limit', 'Rate limit reached for requests');
      await page.goto('/');

      await page.locator('[data-slot="textarea"]').fill('Hello');
      await pauseBeforeAction(page, testInfo);
      await page.locator('button[aria-label="Send message"]').click();

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(
        assistantMsg.getByText(
          'The provider is rate-limiting requests. Wait a bit before retrying.',
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(assistantMsg.getByText('Rate limit reached for requests')).not.toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await assistantMsg.getByText('Show details').click();
      await expect(assistantMsg.getByText('Rate limit reached for requests')).toBeVisible();
    });
  },
);
