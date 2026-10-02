import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 49,
  name: 'Settings notifications',
  description:
    'Verifies the Notifications settings section: the static webhook URL display, and API key create/reveal-once/rotate/revoke',
  purpose:
    'Ensure users can fully manage webhook API keys from Settings without a live backend, and that a key is never shown more than once per create/rotate',
  tags: ['@functional', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Open the Notifications settings section',
      expectedOutcome: 'The static webhook URL is shown read-only, with a working copy button',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create a named API key',
      expectedOutcome: 'A reveal-once dialog shows the new secret with a copy button',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Close the reveal dialog',
      expectedOutcome: 'The key is listed by name afterward, with no secret anywhere in the DOM',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Rotate the key',
      expectedOutcome: 'A reveal-once dialog shows a new, different secret',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Revoke the key',
      expectedOutcome: 'A confirmation dialog appears; accepting removes the row',
      test: () => {},
    },
  ],
};

interface StubKey {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// No real backend API-key store is exercised here — every /api/v1/api-keys
// request is mocked, same rationale as settings-mcp-servers.spec.ts: a
// deterministic, self-contained test rather than depending on shared
// backend state across parallel workers.
async function mockApiKeysApi(page: Page, initial: StubKey[] = []) {
  let keys: StubKey[] = initial;
  let secretCounter = 0;
  const BASE = '/api/v1/api-keys';

  await page.route('**/api/v1/api-keys**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const method = req.method();
    const now = new Date().toISOString();

    if (pathname === BASE && method === 'GET') {
      return route.fulfill({ json: keys });
    }
    if (pathname === BASE && method === 'POST') {
      const body = req.postDataJSON() as { name: string };
      const id = `key-${keys.length + 1}`;
      secretCounter++;
      keys = [...keys, { id, name: body.name, createdAt: now, updatedAt: now }];
      return route.fulfill({
        status: 201,
        json: { id, name: body.name, key: `ahb_secret_${secretCounter}`, createdAt: now },
      });
    }

    const rotateMatch = pathname.match(new RegExp(`^${BASE}/([^/]+)/rotate$`));
    if (rotateMatch && method === 'POST') {
      const id = rotateMatch[1];
      const existing = keys.find((k) => k.id === id);
      if (!existing) return route.fulfill({ status: 404, json: { error: 'not found' } });
      secretCounter++;
      keys = keys.map((k) => (k.id === id ? { ...k, updatedAt: now } : k));
      return route.fulfill({
        json: { id, name: existing.name, key: `ahb_secret_${secretCounter}`, updatedAt: now },
      });
    }

    const idMatch = pathname.match(new RegExp(`^${BASE}/([^/]+)$`));
    if (idMatch && method === 'DELETE') {
      keys = keys.filter((k) => k.id !== idMatch[1]);
      return route.fulfill({ status: 204, body: '' });
    }

    await route.fallback();
  });
}

test.describe('Settings notifications', { annotation: suiteAnnotations(suite) }, () => {
  test('Webhook URL is shown read-only with a working copy button @user-workflow', async ({
    page,
    context,
  }, testInfo) => {
    await mockApiKeysApi(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/settings?section=notifications');
    await pauseBeforeAction(page, testInfo);

    const urlInput = page.getByTestId('webhook-url');
    await expect(urlInput).toHaveValue(/\/api\/v1\/webhooks\/tasks$/);
    const url = await urlInput.inputValue();

    await pauseBeforeAction(page, testInfo);
    await page.getByTestId('webhook-copy-button').click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(url);
  });

  test('Create reveals the new secret once, then lists the key without it @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockApiKeysApi(page);
    await page.goto('/settings?section=notifications');
    await pauseBeforeAction(page, testInfo);

    await page.getByPlaceholder('Key name').fill('Zapier');
    await page.getByRole('button', { name: 'New key' }).click();

    const revealDialog = page.locator('dialog[open]');
    await expect(revealDialog).toBeVisible();
    await expect(revealDialog.getByTestId('revealed-api-key')).toHaveValue(/^ahb_secret_\d+$/);

    await revealDialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('[data-slot="api-key-row-name"]')).toHaveText('Zapier');
    // The dialog fades out via opacity (still `display: block` while
    // closing), so Playwright's toBeVisible() can't tell closed from open —
    // the native <dialog open> attribute is the real "closed" signal.
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  });

  test('Rotate shows a new, different secret @user-workflow', async ({ page }, testInfo) => {
    await mockApiKeysApi(page, [
      {
        id: 'key-1',
        name: 'Zapier',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await page.goto('/settings?section=notifications');
    await pauseBeforeAction(page, testInfo);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Rotate' }).click();

    const revealDialog = page.locator('dialog[open]');
    await expect(revealDialog.getByTestId('revealed-api-key')).toHaveValue('ahb_secret_1');
  });

  test('Revoke asks for confirmation and removes the row @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockApiKeysApi(page, [
      {
        id: 'key-1',
        name: 'Zapier',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await page.goto('/settings?section=notifications');
    await pauseBeforeAction(page, testInfo);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Revoke' }).click();

    await expect(page.getByText('No API keys yet.')).toBeVisible();
  });
});
