import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 53,
  name: 'Dashboard',
  description:
    'Verifies the dashboard renders as the app landing page with a responsive widget grid',
  purpose: 'Catch regressions in the dashboard landing page and its grid responsiveness',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load /',
      expectedOutcome:
        'Dashboard renders with at least one markdown widget showing title, subtitle, and rendered content',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'From Wiki, click the sidebar Dashboard link',
      expectedOutcome: 'Navigates to / with widgets visible',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Resize to mobile/tablet/desktop widths',
      expectedOutcome: 'Grid column count changes per breakpoint with no horizontal overflow',
      test: () => {},
    },
  ],
};

async function gridColumnCount(page: Page): Promise<number> {
  const value = await page.locator('[data-testid="dashboard-grid"]').evaluate((el) => {
    return getComputedStyle(el).gridTemplateColumns;
  });
  return value.trim().split(/\s+/).length;
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('dashboard renders with widget content', async ({ page }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await expect(page.getByTestId('dashboard-grid')).toBeVisible();

      const firstCard = page.getByTestId('widget-card').first();
      await expect(firstCard).toBeVisible();
      await expect(firstCard.getByText('Welcome')).toBeVisible();
      await expect(firstCard.getByText('Your AI Workspace')).toBeVisible();
      await expect(
        firstCard.getByRole('heading', { name: 'Welcome to Amazing Hashbrown' }),
      ).toBeVisible();
    });

    test('sidebar Dashboard link navigates home', async ({ page }, testInfo) => {
      await page.goto('/wiki');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('link', { name: 'Dashboard' }).click();

      await expect(page).toHaveURL('/');
      await expect(page.getByTestId('dashboard-grid')).toBeVisible();
    });

    test.describe('Mobile viewport (<640px)', () => {
      test.use({ viewport: { width: 375, height: 812 } });

      test('grid renders a single column with no horizontal overflow', async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(1);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(375 + 1);
      });
    });

    test.describe('Tablet viewport (640-1023px)', () => {
      test.use({ viewport: { width: 800, height: 900 } });

      test('grid renders two columns with no horizontal overflow', async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(2);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(800 + 1);
      });
    });

    test.describe('Desktop viewport (>=1024px)', () => {
      test.use({ viewport: { width: 1280, height: 900 } });

      test('grid renders three columns with no horizontal overflow', async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(3);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(1280 + 1);
      });
    });
  },
);
