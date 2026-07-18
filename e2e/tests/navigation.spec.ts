import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';

const suite: TestSuite = {
  id: 3,
  name: 'Navigation',
  description:
    'Verifies the thread sidebar renders on desktop and the bottom nav / sheet on mobile',
  purpose: 'Ensure navigation landmarks are accessible and visible at all supported viewports',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load / on a desktop viewport',
      expectedOutcome: 'Sidebar is visible with a New conversation button',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load / on a mobile viewport (375×812)',
      expectedOutcome: 'Bottom navigation bar is visible',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Check desktop sidebar on mobile viewport',
      expectedOutcome: 'Desktop sidebar is hidden',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Click the mobile menu button',
      expectedOutcome:
        'Navigation sheet slides up with the thread sidebar (New conversation button)',
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
    test('desktop sidebar is visible with a New conversation button', async ({ page }) => {
      await page.goto('/');
      const sidebar = page.locator('aside[aria-label="Sidebar navigation"]');
      await expect(sidebar).toBeVisible();
      await expect(sidebar.locator('button[aria-label="New conversation"]')).toBeVisible();
    });

    test.describe('mobile viewport', () => {
      test.use({ viewport: { width: 375, height: 812 } });

      test('bottom navigation bar is visible on mobile', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('nav[aria-label="Bottom navigation"]')).toBeVisible();
      });

      test('desktop sidebar is hidden on mobile', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('aside[aria-label="Sidebar navigation"]')).not.toBeVisible();
      });

      test('mobile menu button opens navigation sheet', async ({ page }) => {
        await page.goto('/');
        await page.locator('button[aria-label="Open navigation menu"]').click();
        await expect(page.getByRole('button', { name: 'New conversation' }).first()).toBeVisible();
      });
    });
  },
);
