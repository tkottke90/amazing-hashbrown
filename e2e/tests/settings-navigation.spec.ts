import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 12,
  name: 'Settings navigation',
  description:
    'Verifies the Settings page routing, ?section= query param, nav item active states, and default section fallback against a mocked settings API',
  purpose: 'Ensure settings navigation wires up correctly without a live backend or config file',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Click the Settings icon in the nav bar',
      expectedOutcome: '/settings loads and the general panel renders',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Navigate to /settings without a ?section param',
      expectedOutcome: 'General section renders by default',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Click "Storage" in the settings nav',
      expectedOutcome: '?section=storage appears in the URL and storage panel renders',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Navigate to /settings?section=bogus',
      expectedOutcome: 'General panel renders as fallback',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Check active nav item attribute',
      expectedOutcome: 'The active item has data-active="true", others have data-active="false"',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load settings on mobile viewport',
      expectedOutcome: 'Settings page renders without horizontal scrolling',
      test: () => {},
    },
  ],
};

type StubMap = Record<string, unknown>;

const STUBS: StubMap = {
  general: { port: 3000, logLevel: 'info' },
  storage: {
    wikiRoot: './wiki',
    mcpConfigDir: './mcp',
    artifactRoot: './artifacts',
    skillsRoot: './skills',
    database: { path: 'app.db' },
  },
  'model-providers': { providers: [], defaultProvider: '' },
  embeddings: {
    enabled: true,
    type: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434/v1',
  },
  'agent-behavior': {
    afterAgent: { enabled: true },
    chat: { showErrorMessages: false },
    observability: { enabled: true, spanOutputPreviewChars: 500 },
  },
  tools: {
    webFetch: { timeoutMs: 10000, respectRobotsTxt: true },
    rlm: { maxIterations: 10, truncateThreshold: 6000 },
    tools: undefined,
  },
  'cost-rates': { costs: {} },
  'mcp-servers': {},
  skills: {},
};

async function mockSettingsApi(page: Page, stubs: StubMap = STUBS) {
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

test.describe('Settings navigation', { annotation: suiteAnnotations(suite) }, () => {
  test('Settings icon navigates to /settings and general panel renders @smoke', async ({
    page,
    browserName: _browserName,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/wiki');
    await pauseBeforeAction(page, testInfo);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByLabel('Log level')).toBeVisible();
  });

  test('Missing ?section param defaults to general @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByRole('button', { name: 'General' }).first()).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.getByLabel('Log level')).toBeVisible();
  });

  test('Clicking "Storage" nav item sets ?section=storage @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);
    await page.getByRole('button', { name: 'Storage' }).click();
    await expect(page).toHaveURL(/section=storage/);
    await expect(page.getByLabel('Wiki root')).toBeVisible();
  });

  test('Invalid ?section=bogus falls back to general panel @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=bogus');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByLabel('Log level')).toBeVisible();
    await expect(page.getByRole('button', { name: 'General' }).first()).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  test('Active nav item has data-active="true" @smoke', async ({ page }) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=embeddings');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await expect(page.getByRole('button', { name: 'Embeddings' })).toHaveAttribute(
      'data-active',
      'true',
    );
    await expect(page.getByRole('button', { name: 'General' })).toHaveAttribute(
      'data-active',
      'false',
    );
  });

  test.describe('Mobile viewport @smoke', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('Settings page renders on mobile without horizontal scroll @smoke', async ({
      page,
    }, testInfo) => {
      await mockSettingsApi(page);
      await page.goto('/settings');
      await pauseBeforeAction(page, testInfo);
      await page.waitForSelector('[data-slot="settings-nav-item"]');
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const clientWidth = await page.evaluate(() => document.body.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  });
});
