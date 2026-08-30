import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
// `import type` only — erased entirely by Playwright's transform, so these never
// evaluate api/src/routes/v1/settings.handlers.ts (which has module-load side
// effects like loadConfig()) at test-run time. See that file for why these types
// exist: they're the canonical shape of each settings section's GET response /
// full-object PATCH body. Importing them (instead of hand-declaring the shape
// here) means an API schema change surfaces as a compile error in this file
// instead of a silently-stale assertion.
import type {
  GeneralSettings,
  StorageSettings,
  ModelProvidersSettings,
  EmbeddingsSettings,
  AgentBehaviorSettings,
  ToolsSettings,
  CostRatesSettings,
} from '../../api/src/routes/v1/settings.handlers.js';

const suite: TestSuite = {
  id: 14,
  name: 'Settings save contracts',
  description:
    'For each editable settings section, modifies a field and asserts the outgoing PATCH request body matches the expected section shape imported from the API',
  purpose:
    'Catch cases where a form edit fails to reach the request body, is sent under the wrong key, or drifts from the API schema — render-only assertions (see Settings sections suite) cannot catch any of these',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Change General log level and Save',
      expectedOutcome: 'PATCH body equals the full General section with only logLevel changed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Edit a Storage path and Save',
      expectedOutcome: 'PATCH body equals the full Storage section with only wikiRoot changed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add a provider via the modal and Save',
      expectedOutcome:
        'PATCH body providers array includes the new provider with the fields entered',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Edit the Embeddings model field and Save',
      expectedOutcome: 'PATCH body equals the full Embeddings section with only model changed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle "Show error messages" in Agent behavior and Save',
      expectedOutcome:
        'PATCH body equals the full Agent behavior section with only chat.showErrorMessages changed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Edit RLM max iterations in Tools and Save',
      expectedOutcome:
        'PATCH body equals the full Tools section with only rlm.maxIterations changed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add a cost rate via the provider/model picker and Save',
      expectedOutcome:
        'PATCH body costs map includes the new provider/model key with the entered prices',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add a cost rate with the 1M scale toggle selected and Save',
      expectedOutcome:
        'PATCH body normalizes the entered 1M-scale price to per-1k and records the 1M scale',
      test: () => {},
    },
  ],
};

// Typed against the API's section shapes so a schema change (new required field,
// renamed key, etc.) breaks this fixture at compile time rather than leaving a
// stale stub that happens to still satisfy `unknown`.
const STUBS: {
  general: GeneralSettings;
  storage: StorageSettings;
  'model-providers': ModelProvidersSettings;
  embeddings: EmbeddingsSettings;
  'agent-behavior': AgentBehaviorSettings;
  tools: ToolsSettings;
  'cost-rates': CostRatesSettings;
} = {
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
    tools: {
      shell: {
        // workingDirectory/env are required in the parsed output (they're
        // zod .default()s in ShellExecutorConfigSchema, so the real GET
        // response always includes them, even though the UI's own local
        // ShellConfig interface in tools-panel.tsx marks them optional).
        workingDirectory: '/app',
        allowlist: ['**/*.txt'],
        denylist: [],
        env: { PATH: '/usr/bin' },
      },
    },
  },
  'cost-rates': { costs: {} },
};

type StubMap = typeof STUBS;

/**
 * Mocks the settings API and returns a map that fills in, per slug, with the
 * exact parsed JSON body of the most recent PATCH request to that slug — the
 * request-contract equivalent of a spy. Capture happens before `route.fulfill`,
 * so by the time a caller awaits the resulting UI reaction (e.g. the success
 * toast), the corresponding entry is already populated.
 */
async function mockSettingsApi(
  page: Page,
  stubs: StubMap = STUBS,
): Promise<Partial<Record<keyof StubMap, unknown>>> {
  const captured: Partial<Record<keyof StubMap, unknown>> = {};
  await page.route('**/api/v1/settings/**', async (route) => {
    const slug = new URL(route.request().url()).pathname.split('/').pop()! as keyof StubMap;
    if (route.request().method() === 'GET' && stubs[slug] !== undefined) {
      await route.fulfill({ json: { ok: true, data: stubs[slug] } });
      return;
    }
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      captured[slug] = body;
      await route.fulfill({ json: { ok: true, data: body } });
      return;
    }
    await route.fallback();
  });
  return captured;
}

/**
 * Mocks POST /api/v1/providers/models — the live model-list endpoint behind
 * the provider modal's "Default model" and the embeddings panel's "Model"
 * Select (both replaced free-text inputs with a dropdown populated from a
 * real provider call). Tests need a deterministic option list rather than
 * depending on network access to a real Ollama/OpenAI/etc. server.
 */
async function mockProviderModelsApi(page: Page, models: string[]): Promise<void> {
  await page.route('**/api/v1/providers/models', async (route) => {
    await route.fulfill({ json: { ok: true, data: { models } } });
  });
}

/**
 * Mocks GET /api/v1/providers — the provider+model list behind the Cost
 * rates "Add rate" modal's provider/model picker (and the chat input's own
 * model switcher). Deliberately a separate route from
 * `**\/api/v1/providers/models` above: that one is POST and lists live
 * models for the provider-modal's Select; this one is GET and returns the
 * already-configured provider list with their model IDs.
 */
async function mockProvidersListApi(
  page: Page,
  providers: Array<{ name: string; type: string; defaultModel?: string; models: { id: string }[] }>,
): Promise<void> {
  await page.route('**/api/v1/providers', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { providers, defaultProvider: '' } });
  });
}

const SAVED_TOAST = { role: 'alert' as const, hasText: 'Settings saved' };

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByRole(SAVED_TOAST.role).filter({ hasText: SAVED_TOAST.hasText }),
  ).toBeVisible();
}

test.describe('Settings save contracts', { annotation: suiteAnnotations(suite) }, () => {
  test('General: Save sends the full section with only logLevel changed @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    await page.goto('/settings?section=general');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await page.getByLabel('Log level').click();
    await page.getByRole('option', { name: 'debug' }).click();
    await save(page);

    const expected: GeneralSettings = { port: 3000, logLevel: 'debug' };
    expect(captured.general).toEqual(expected);
  });

  test('Storage: Save sends the full section with only wikiRoot changed @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    await page.goto('/settings?section=storage');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await page.getByLabel('Wiki root').fill('/new/wiki');
    await save(page);

    const expected: StorageSettings = {
      wikiRoot: '/new/wiki',
      mcpConfigDir: './mcp',
      artifactRoot: './artifacts',
      skillsRoot: './skills',
      database: { path: 'app.db' },
    };
    expect(captured.storage).toEqual(expected);
  });

  test('Model providers: adding a provider sends it in the providers array @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    // Default model is a Select populated by a real call to the provider —
    // give it something deterministic to list instead of hitting a real
    // OpenAI endpoint.
    await mockProviderModelsApi(page, ['gpt-4o', 'gpt-4o-mini']);
    await page.goto('/settings?section=model-providers');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    // Stubbed with zero existing providers, so only one "Add provider" dialog
    // exists on the page — no need to scope past the trigger/submit text
    // collision the way the Cost rates test below has to. Field lookups are
    // still scoped to the dialog itself, though: the sidebar always renders
    // every real thread from the shared dev backend, and getByLabel matches
    // substrings by default — a thread renamed by a different, concurrently
    // running spec (thread-persistence.spec.ts uses "Renamed by e2e ...")
    // has an "Options for Renamed by e2e ..." button whose accessible name
    // contains "Name" (inside "reNAMEd"), which would otherwise collide
    // with page.getByLabel('Name').
    await page.getByRole('button', { name: 'Add provider' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('openai-test');
    await dialog.getByLabel('Type').click();
    await page.getByRole('option', { name: 'openai' }).click();
    await dialog.getByLabel('Base URL').fill('https://api.openai.com/v1');
    // Add-mode starts with an empty Base URL, so the Select's auto-load (on
    // dialog open) bailed out with a "Base URL is required" error before we
    // filled it in above — refresh explicitly now that there's a URL to use.
    await dialog.getByRole('button', { name: 'Refresh model list' }).click();
    await dialog.getByLabel('Default model').click();
    await page.getByRole('option', { name: 'gpt-4o', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add provider' }).click();

    await save(page);

    const expected: ModelProvidersSettings = {
      providers: [
        {
          name: 'openai-test',
          type: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o',
        },
      ],
      defaultProvider: '',
    };
    expect(captured['model-providers']).toEqual(expected);
  });

  test('Embeddings: Save sends the full section with only model changed @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    // Model is a Select populated by a real call to the provider — give it
    // something deterministic to list instead of hitting a real server.
    // The stub's baseUrl is non-empty, so the panel auto-loads this on
    // mount; Playwright's actionability retry on the option click below
    // waits it out rather than racing it explicitly.
    await mockProviderModelsApi(page, ['mxbai-embed-large', 'nomic-embed-text']);
    await page.goto('/settings?section=embeddings');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await page.getByLabel('Model').click();
    await page.getByRole('option', { name: 'mxbai-embed-large', exact: true }).click();
    await save(page);

    const expected: EmbeddingsSettings = {
      enabled: true,
      type: 'ollama',
      model: 'mxbai-embed-large',
      baseUrl: 'http://localhost:11434/v1',
    };
    expect(captured.embeddings).toEqual(expected);
  });

  test('Agent behavior: Save sends the full section with only chat.showErrorMessages changed @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    await page.goto('/settings?section=agent-behavior');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('switch', { name: 'Show error messages' }).click();
    await save(page);

    const expected: AgentBehaviorSettings = {
      afterAgent: { enabled: true },
      chat: { showErrorMessages: true },
      observability: { enabled: true, spanOutputPreviewChars: 500 },
    };
    expect(captured['agent-behavior']).toEqual(expected);
  });

  test('Tools: Save sends the full section with only rlm.maxIterations changed @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    await page.goto('/settings?section=tools');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await page.getByLabel('Max iterations').fill('20');
    await save(page);

    const expected: ToolsSettings = {
      webFetch: { timeoutMs: 10000, respectRobotsTxt: true },
      rlm: { maxIterations: 20, truncateThreshold: 6000 },
      tools: {
        shell: {
          workingDirectory: '/app',
          allowlist: ['**/*.txt'],
          denylist: [],
          env: { PATH: '/usr/bin' },
        },
      },
    };
    expect(captured.tools).toEqual(expected);
  });

  test('Cost rates: adding a rate sends it in the costs map @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    await mockProvidersListApi(page, [
      { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o-mini' }] },
    ]);
    await page.goto('/settings?section=cost-rates');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    // Stubbed with an empty costs map, so — same as Model providers above —
    // only one "Add rate" dialog exists and the trigger/submit text collision
    // only affects the very first click, resolved with .first().
    await page.getByRole('button', { name: 'Add rate' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Select provider/model…').click();
    await dialog.getByText('openai').click();
    await dialog.getByText('gpt-4o-mini').click();
    await dialog.getByLabel('Input cost').fill('0.01');
    await dialog.getByLabel('Output cost').fill('0.03');
    await dialog.getByRole('button', { name: 'Add rate' }).click();

    await save(page);

    const expected: CostRatesSettings = {
      costs: {
        'openai/gpt-4o-mini': {
          inputPer1kTokens: 0.01,
          inputScale: '1k',
          outputPer1kTokens: 0.03,
          outputScale: '1k',
        },
      },
    };
    expect(captured['cost-rates']).toEqual(expected);
  });

  test('Cost rates: entering a 1M-scale price normalizes it to per-1k on save @user-workflow', async ({
    page,
  }, testInfo) => {
    const captured = await mockSettingsApi(page);
    await mockProvidersListApi(page, [
      { name: 'glm', type: 'openai', models: [{ id: 'glm-5.3' }] },
    ]);
    await page.goto('/settings?section=cost-rates');
    await page.waitForSelector('[data-slot="settings-nav-item"]');
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('button', { name: 'Add rate' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Select provider/model…').click();
    await dialog.getByText('glm').click();
    await dialog.getByText('glm-5.3').click();

    // Each ScaledCostInput renders its own "1M"/"1k" radio pair with the same
    // accessible names, so scope each toggle to its own field via the
    // number input it sits beside (rate-modal.tsx's grid layout puts them in
    // the same row).
    await dialog
      .locator('#rate-input')
      .locator('xpath=..')
      .getByRole('radio', { name: '1M' })
      .click();
    await dialog.getByLabel('Input cost').fill('1.4');
    await dialog
      .locator('#rate-output')
      .locator('xpath=..')
      .getByRole('radio', { name: '1M' })
      .click();
    await dialog.getByLabel('Output cost').fill('4.4');

    await dialog.getByRole('button', { name: 'Add rate' }).click();
    await save(page);

    const expected: CostRatesSettings = {
      costs: {
        'glm/glm-5.3': {
          inputPer1kTokens: 0.0014,
          inputScale: '1M',
          outputPer1kTokens: 0.0044,
          outputScale: '1M',
        },
      },
    };
    expect(captured['cost-rates']).toEqual(expected);
  });
});
