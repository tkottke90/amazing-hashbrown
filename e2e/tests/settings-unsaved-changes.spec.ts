import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 24,
  name: 'Settings unsaved-changes guard',
  description:
    'Verifies that navigating away from a dirty Settings section — switching sections or leaving Settings via the app sidebar — prompts a confirmation, and that cancelling/accepting behaves correctly',
  purpose:
    'Prevent silently discarding unsaved settings edits when the user switches sections or leaves Settings entirely',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Dirty General, then click "Storage" and dismiss the confirmation',
      expectedOutcome: 'Stays on General with the edit intact',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Dirty General, then click "Storage" and accept the confirmation',
      expectedOutcome:
        'Navigates to Storage; returning to General shows the original (discarded) value',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Dirty General, then click the "Wiki" sidebar link',
      expectedOutcome: 'Dismissing keeps you on Settings; accepting navigates to /wiki',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'With no unsaved changes, click away from General',
      expectedOutcome: 'Navigation completes immediately with no confirmation dialog',
      test: () => {},
    },
  ],
};

const STUBS: Record<string, unknown> = {
  general: { port: 3000, logLevel: 'info' },
  storage: {
    wikiRoot: './wiki',
    mcpConfigDir: './mcp',
    artifactRoot: './artifacts',
    skillsRoot: './skills',
    database: { path: 'app.db' },
  },
};

async function mockSettingsApi(page: Page, stubs: Record<string, unknown> = STUBS) {
  await page.route('**/api/v1/settings/**', async (route) => {
    const slug = new URL(route.request().url()).pathname.split('/').pop()!;
    if (route.request().method() === 'GET' && stubs[slug] !== undefined) {
      await route.fulfill({ json: { ok: true, data: stubs[slug] } });
      return;
    }
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ json: { ok: true, data: route.request().postDataJSON() } });
      return;
    }
    await route.fallback();
  });
}

async function dirtyGeneralLogLevel(page: Page) {
  await page.getByLabel('Log level').click();
  await page.getByRole('option', { name: 'debug' }).click();
}

test.describe('Settings unsaved-changes guard', { annotation: suiteAnnotations(suite) }, () => {
  test('Dismissing the confirmation keeps you on the dirty section @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await dirtyGeneralLogLevel(page);

    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: 'Storage' }).click();

    await expect(page).not.toHaveURL(/section=storage/);
    await expect(page.getByLabel('Log level')).toContainText('debug');
  });

  test('Accepting the confirmation navigates and discards the edit @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await dirtyGeneralLogLevel(page);

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Storage' }).click();

    await expect(page).toHaveURL(/section=storage/);
    await expect(page.getByLabel('Wiki root')).toBeVisible();

    await page.getByRole('button', { name: 'General' }).click();
    await expect(page.getByLabel('Log level')).toContainText('info');
  });

  test('The app sidebar is guarded too, not just section switching @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await dirtyGeneralLogLevel(page);

    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('link', { name: 'Wiki' }).click();
    await expect(page).toHaveURL(/\/settings/);

    page.once('dialog', (d) => d.accept());
    await page.getByRole('link', { name: 'Wiki' }).click();
    await expect(page).toHaveURL(/\/wiki/);
  });

  test('No unsaved changes navigates immediately with no dialog @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    // No `page.on('dialog', ...)` handler is registered — if one appeared
    // unexpectedly, Playwright would hang waiting on it and this test would
    // time out, so a clean pass itself proves no dialog fired.
    await page.getByRole('button', { name: 'Storage' }).click();
    await expect(page).toHaveURL(/section=storage/);
  });
});
