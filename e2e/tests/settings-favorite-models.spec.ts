import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
// `import type` only — erased by Playwright's transform (see
// settings-save-contracts.spec.ts for why these are imported, not redeclared).
import type { ModelProvidersSettings } from '../../api/src/routes/v1/settings.handlers.js';

const suite: TestSuite = {
  id: 41,
  name: 'Favorite models',
  description:
    'Adds and removes favorite provider/model pairs on the Model providers settings page and verifies they appear as a flat, selectable Favorites section at the top of the chat Provider menu (issue #137)',
  purpose:
    'Router providers expose dozens of models; favorites are the shortcut to the few actually used. This guards the full loop: settings edit -> saved config -> chat menu entry -> model switch, plus the path back to settings',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'On Model providers, click Add favorite, pick openai -> gpt-4o-mini, add, and Save',
      expectedOutcome:
        'A "openai / gpt-4o-mini" row appears and the PATCH body carries it in favoriteModels',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'With a saved favorite, open chat "Add to message" -> Provider',
      expectedOutcome:
        'A Favorites section lists "openai / gpt-4o-mini" above the provider entries',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Select the favorite',
      expectedOutcome: 'The model chip shows gpt-4o-mini',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click "Configure favorites…"',
      expectedOutcome: 'The Model providers settings page opens with the favorite listed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Remove the favorite in settings, Save, and reopen the chat Provider menu',
      expectedOutcome: 'No Favorites section is shown; the provider entries remain',
      test: () => {},
    },
  ],
};

const LIVE_PROVIDERS = [
  {
    name: 'openai',
    type: 'openai',
    defaultModel: 'gpt-4o',
    models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
  },
  { name: 'ollama', type: 'ollama', models: [{ id: 'llama3.2' }] },
];

type Favorite = { provider: string; model: string };

/**
 * Stateful stand-in for the backend: the model-providers settings section
 * and GET /api/v1/providers share one favorites list, so a Save in settings
 * is visible to the chat menu exactly as it would be against the real API.
 * Returns the state so tests can assert on what was saved.
 */
async function mockBackend(page: Page, initialFavorites: Favorite[] = []) {
  const state: { section: ModelProvidersSettings; lastPatch?: unknown } = {
    section: {
      providers: [
        { name: 'openai', type: 'openai', defaultModel: 'gpt-4o' },
        { name: 'ollama', type: 'ollama' },
      ],
      defaultProvider: 'openai',
      favoriteModels: initialFavorites,
    },
  };

  await page.route('**/api/v1/settings/model-providers', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Partial<ModelProvidersSettings>;
      state.lastPatch = body;
      state.section = { ...state.section, ...body };
    }
    await route.fulfill({ json: { ok: true, data: state.section } });
  });

  // Each existing provider's Edit modal pre-loads its model list on mount.
  await page.route('**/api/v1/providers/models', async (route) => {
    await route.fulfill({ json: { ok: true, data: { models: [] } } });
  });

  await page.route('**/api/v1/providers', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        providers: LIVE_PROVIDERS,
        defaultProvider: 'openai',
        favoriteModels: state.section.favoriteModels,
      },
    });
  });

  return state;
}

async function saveSettings(page: Page) {
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Settings saved' })).toBeVisible();
}

async function openChatProviderMenu(page: Page) {
  await page.locator('button[aria-label="Add to message"]').click();
  await page.getByRole('menuitem', { name: 'Provider' }).hover();
}

test.describe('Favorite models', { annotation: suiteAnnotations(suite) }, () => {
  test('adds a favorite from the Model providers page and saves it @user-workflow', async ({
    page,
  }, testInfo) => {
    const state = await mockBackend(page);
    await page.goto('/settings?section=model-providers');
    await expect(page.getByText(/No favorite models/)).toBeVisible();
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('button', { name: 'Add favorite' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Select provider/model…' }).click();
    await page.getByRole('menuitem', { name: 'openai', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'gpt-4o-mini', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add favorite' }).click();

    await expect(page.locator('[data-slot="favorite-row"]')).toHaveText(/openai \/ gpt-4o-mini/);
    await saveSettings(page);

    expect((state.lastPatch as ModelProvidersSettings).favoriteModels).toEqual([
      { provider: 'openai', model: 'gpt-4o-mini' },
    ]);
  });

  test('lists a saved favorite above the providers in the chat Provider menu and selecting it switches the model @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockBackend(page, [{ provider: 'openai', model: 'gpt-4o-mini' }]);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await openChatProviderMenu(page);
    const favorite = page.getByRole('menuitemcheckbox', { name: 'openai / gpt-4o-mini' });
    await expect(page.getByText('Favorites', { exact: true })).toBeVisible();
    await expect(favorite).toBeVisible();

    const favoriteBox = await favorite.boundingBox();
    const providerBox = await page
      .getByRole('menuitem', { name: 'openai', exact: true })
      .boundingBox();
    if (!favoriteBox || !providerBox) throw new Error('missing bounding box');
    expect(favoriteBox.y).toBeLessThan(providerBox.y);

    await favorite.click();
    await expect(page.locator('[data-slot="model-chip"]')).toHaveText('gpt-4o-mini');
  });

  test('"Configure favorites…" opens the Model providers settings page @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockBackend(page, [{ provider: 'openai', model: 'gpt-4o-mini' }]);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await openChatProviderMenu(page);
    await page.getByRole('menuitem', { name: 'Configure favorites…' }).click();

    await expect(page).toHaveURL(/\/settings\?section=model-providers/);
    await expect(page.locator('[data-slot="favorite-row"]')).toHaveText(/openai \/ gpt-4o-mini/);
  });

  test('removing the last favorite hides the Favorites section in chat @user-workflow', async ({
    page,
  }, testInfo) => {
    const state = await mockBackend(page, [{ provider: 'openai', model: 'gpt-4o-mini' }]);
    await page.goto('/settings?section=model-providers');
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('button', { name: 'Remove openai / gpt-4o-mini' }).click();
    await expect(page.getByText(/No favorite models/)).toBeVisible();
    await saveSettings(page);
    expect((state.lastPatch as ModelProvidersSettings).favoriteModels).toEqual([]);

    await page.goto('/');
    await openChatProviderMenu(page);
    await expect(page.getByRole('menuitem', { name: 'openai', exact: true })).toBeVisible();
    await expect(page.getByText('Favorites', { exact: true })).toHaveCount(0);
  });
});
