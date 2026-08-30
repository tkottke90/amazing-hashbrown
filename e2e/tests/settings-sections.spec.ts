import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 13,
  name: 'Settings sections',
  description:
    'Verifies Save/Discard bar behavior, field rendering, conditional visibility, and modal interactions for all settings section panels',
  purpose:
    'Ensure each panel correctly fetches, displays, and edits its settings slice without a live backend',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load General section',
      expectedOutcome: 'Port is read-only and log level select is present',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Change log level in General and click Discard',
      expectedOutcome: 'Save/Discard bar appears; after Discard it disappears and value resets',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Storage section',
      expectedOutcome: 'All 5 storage inputs render with fetched values',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Edit a storage path and Save',
      expectedOutcome: 'PATCH is sent with the new value; success toast appears',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Model providers section',
      expectedOutcome:
        'Provider rows render with type badge and Default badge on the default provider',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Embeddings section with enabled=false',
      expectedOutcome: 'Conditional fields (Type, Model, Base URL) are hidden',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle Embeddings enabled on',
      expectedOutcome: 'Conditional fields become visible',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Agent behavior section',
      expectedOutcome: '3 card headings render; span preview visible when observability enabled',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Tools section',
      expectedOutcome: '3 card headings and allowlist textarea render',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Cost rates with empty costs',
      expectedOutcome: 'Empty state renders with Add rate prompt',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load MCP Servers section',
      expectedOutcome: '"Management UI coming soon." placeholder renders',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load Skills section',
      expectedOutcome: '"Management UI coming soon." placeholder renders',
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
  'model-providers': {
    providers: [
      { name: 'ollama', type: 'ollama', defaultModel: 'llama3' },
      { name: 'openai', type: 'openai', apiKey: '****' },
    ],
    defaultProvider: 'ollama',
  },
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
    tools: { shell: { allowlist: ['**/*.txt'], denylist: [] } },
  },
  'cost-rates': {
    costs: {
      'gpt-4o': {
        inputPer1kTokens: 0.005,
        inputScale: '1k',
        outputPer1kTokens: 0.015,
        outputScale: '1k',
      },
    },
  },
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
      // Echo back the PATCH body as the new data
      await route.fulfill({ json: { ok: true, data: route.request().postDataJSON() } });
      return;
    }
    await route.fallback();
  });
}

test.describe('Settings sections', { annotation: suiteAnnotations(suite) }, () => {
  // ---- General -----------------------------------------------------------

  test('General: port is read-only and log level select is present @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await pauseBeforeAction(page, testInfo);
    const portInput = page.getByLabel('Port');
    await expect(portInput).toBeVisible();
    await expect(portInput).toHaveAttribute('readonly');
    await expect(page.getByLabel('Log level')).toBeVisible();
  });

  test('General: Save/Discard bar hidden initially; appears after change; Discard resets @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');

    await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();

    // Open log level select and pick a different option
    await pauseBeforeAction(page, testInfo);
    await page.getByLabel('Log level').click();
    await page.getByRole('option', { name: 'debug' }).click();

    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();

    await pauseBeforeAction(page, testInfo);
    await page.getByRole('button', { name: 'Discard' }).click();

    await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();
  });

  test('General: Save sends PATCH and shows success toast @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await page.getByLabel('Log level').click();
    await page.getByRole('option', { name: 'warn' }).click();
    await pauseBeforeAction(page, testInfo);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Settings saved' })).toBeVisible();
  });

  // ---- Storage -----------------------------------------------------------

  test('Storage: all 5 inputs render with fetched values @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=storage');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByLabel('Wiki root')).toHaveValue('./wiki');
    await expect(page.getByLabel('MCP config directory')).toHaveValue('./mcp');
    await expect(page.getByLabel('Artifact root')).toHaveValue('./artifacts');
    await expect(page.getByLabel('Skills root')).toHaveValue('./skills');
    await expect(page.getByLabel('Database path')).toHaveValue('app.db');
  });

  test('Storage: editing a path shows Save/Discard bar @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=storage');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();
    await pauseBeforeAction(page, testInfo);
    await page.getByLabel('Wiki root').fill('/new/wiki');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  });

  // ---- Model providers ---------------------------------------------------

  test('Model providers: provider rows render with type badge and Default badge @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=model-providers');
    await pauseBeforeAction(page, testInfo);
    // Scoped to the row-name hook (not a page-wide text match): each closed
    // Edit-provider dialog stays mounted with its own "Type" select — a
    // visible span plus a hidden native <select>'s <option> — so an
    // unscoped getByText('ollama') resolves to several elements once
    // there's more than one provider in the stub.
    const providerNames = page.locator('[data-slot="provider-row-name"]');
    await expect(providerNames.filter({ hasText: 'ollama' })).toBeVisible();
    await expect(providerNames.filter({ hasText: 'openai' })).toBeVisible();
    await expect(page.getByText('Default', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add provider' }).first()).toBeVisible();
  });

  // ---- Embeddings --------------------------------------------------------

  test('Embeddings: conditional fields hidden when enabled=false @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page, {
      ...STUBS,
      embeddings: {
        enabled: false,
        type: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434/v1',
      },
    });
    await page.goto('/settings?section=embeddings');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByLabel('Model')).not.toBeVisible();
    await expect(page.getByLabel('Base URL')).not.toBeVisible();
  });

  test('Embeddings: toggle on reveals conditional fields @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page, {
      ...STUBS,
      embeddings: {
        enabled: false,
        type: 'ollama',
        model: 'nomic-embed-text',
        baseUrl: 'http://localhost:11434/v1',
      },
    });
    await page.goto('/settings?section=embeddings');
    await page.waitForSelector('[role="switch"]');
    await pauseBeforeAction(page, testInfo);
    await page.getByRole('switch', { name: 'Enable embeddings' }).click();
    await expect(page.getByLabel('Model')).toBeVisible();
    await expect(page.getByLabel('Base URL')).toBeVisible();
  });

  // ---- Agent behavior ----------------------------------------------------

  test('Agent behavior: 3 card headings render @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=agent-behavior');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByText('Background processing')).toBeVisible();
    await expect(page.getByText('Conversation history')).toBeVisible();
    await expect(page.getByText('Observability')).toBeVisible();
  });

  test('Agent behavior: span preview hidden when observability disabled @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page, {
      ...STUBS,
      'agent-behavior': {
        afterAgent: { enabled: true },
        chat: { showErrorMessages: false },
        observability: { enabled: false, spanOutputPreviewChars: 500 },
      },
    });
    await page.goto('/settings?section=agent-behavior');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByLabel('Span output preview characters')).not.toBeVisible();
  });

  // ---- Tools -------------------------------------------------------------

  test('Tools: 3 card headings and allowlist textarea render @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=tools');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByText('Web fetch')).toBeVisible();
    await expect(page.getByText('Retrieval loop model')).toBeVisible();
    await expect(page.getByText('Shell execution')).toBeVisible();
    await expect(page.getByLabel('Allowlist (one glob per line)')).toHaveValue('**/*.txt');
  });

  // ---- Cost rates --------------------------------------------------------

  test('Cost rates: empty state renders @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page, { ...STUBS, 'cost-rates': { costs: {} } });
    await page.goto('/settings?section=cost-rates');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByText('No cost rates configured.')).toBeVisible();
  });

  test('Cost rates: populated rows render with model key and prices @smoke', async ({
    page,
  }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=cost-rates');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByText('gpt-4o')).toBeVisible();
    await expect(page.getByText(/In: \$0.005\/1k/)).toBeVisible();
  });

  // ---- Placeholders ------------------------------------------------------

  test('MCP Servers renders "coming soon" placeholder @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=mcp-servers');
    await pauseBeforeAction(page, testInfo);
    await expect(page.locator('p', { hasText: 'MCP Servers' })).toBeVisible();
    await expect(page.getByText('Management UI coming soon.')).toBeVisible();
  });

  test('Skills renders "coming soon" placeholder @smoke', async ({ page }, testInfo) => {
    await mockSettingsApi(page);
    await page.goto('/settings?section=skills');
    await pauseBeforeAction(page, testInfo);
    await expect(page.locator('p', { hasText: 'Skills' })).toBeVisible();
    await expect(page.getByText('Management UI coming soon.')).toBeVisible();
  });

  // ---- Mobile viewport --------------------------------------------------

  test.describe('Mobile viewport @smoke', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('Panels render at mobile viewport without overflow @smoke', async ({ page }, testInfo) => {
      await mockSettingsApi(page);
      await page.goto('/settings?section=general');
      await pauseBeforeAction(page, testInfo);
      await expect(page.getByLabel('Log level')).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const clientWidth = await page.evaluate(() => document.body.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    });
  });
});
