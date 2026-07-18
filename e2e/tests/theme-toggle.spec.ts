import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 4,
  name: 'Theme Toggle',
  description: 'Verifies the theme toggle switches the dark/light class on the html element',
  purpose: 'Ensure users can switch between dark and light modes without a page reload',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Click the theme toggle once',
      expectedOutcome: 'The html element dark class state is inverted',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Click the theme toggle a second time',
      expectedOutcome: 'The html element dark class state returns to its original value',
      test: () => {},
    },
  ],
};

// ThemeToggle lives in the `navEnd` slot, which is rendered exclusively inside
// the mobile bottom nav (lg:hidden). A mobile viewport is required to interact with it.
test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('theme toggle switches between dark and light', async ({ page }, testInfo) => {
      await page.goto('/');
      const html = page.locator('html');

      const startsDark = await html.evaluate((el) => el.classList.contains('dark'));
      const toggleLabel = startsDark ? 'Switch to light theme' : 'Switch to dark theme';
      await pauseBeforeAction(page, testInfo);
      await page.locator(`button[aria-label="${toggleLabel}"]`).click();

      if (startsDark) {
        await expect(html).not.toHaveClass(/\bdark\b/);
      } else {
        await expect(html).toHaveClass(/\bdark\b/);
      }
    });

    test('theme toggle switches back on second click', async ({ page }, testInfo) => {
      await page.goto('/');
      const html = page.locator('html');

      const startsDark = await html.evaluate((el) => el.classList.contains('dark'));

      const label1 = startsDark ? 'Switch to light theme' : 'Switch to dark theme';
      await pauseBeforeAction(page, testInfo);
      await page.locator(`button[aria-label="${label1}"]`).click();

      const label2 = startsDark ? 'Switch to dark theme' : 'Switch to light theme';
      await page.locator(`button[aria-label="${label2}"]`).click();

      if (startsDark) {
        await expect(html).toHaveClass(/\bdark\b/);
      } else {
        await expect(html).not.toHaveClass(/\bdark\b/);
      }
    });
  },
);
