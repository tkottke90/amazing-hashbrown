import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 1,
  name: 'Page Load',
  description: 'Verifies the application shell renders correctly on first navigation',
  purpose: 'Catch regressions in the initial render path and the send-button enable/disable logic',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Navigate to /',
      expectedOutcome: 'The chat textarea is visible',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Inspect send button with empty textarea',
      expectedOutcome: 'Send button is disabled',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Type text into the textarea',
      expectedOutcome: 'Send button becomes enabled',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Clear the textarea',
      expectedOutcome: 'Send button is disabled again',
      test: () => {},
    },
  ],
};

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('page loads and textarea is visible', async ({ page }, testInfo) => {
      await pauseBeforeAction(page, testInfo);
      await page.goto('/');
      await expect(page.locator('[data-slot="textarea"]')).toBeVisible();
    });

    test('send button is disabled when textarea is empty', async ({ page }, testInfo) => {
      await pauseBeforeAction(page, testInfo);
      await page.goto('/');
      await expect(page.locator('button[aria-label="Send message"]')).toBeDisabled();
    });

    test('send button becomes enabled when text is typed', async ({ page }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);
      await page.locator('[data-slot="textarea"]').fill('Hello');
      await expect(page.locator('button[aria-label="Send message"]')).toBeEnabled();
    });

    test('clearing textarea disables send button again', async ({ page }, testInfo) => {
      await page.goto('/');
      await page.locator('[data-slot="textarea"]').fill('Hello');
      await pauseBeforeAction(page, testInfo);
      await page.locator('[data-slot="textarea"]').fill('');
      await expect(page.locator('button[aria-label="Send message"]')).toBeDisabled();
    });
  },
);
