import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 21,
  name: 'Chat Model Picker',
  description:
    'Verifies the provider/model picker sub-menu in the chat input stays open long enough to select a model via keyboard — regression coverage for issue #113',
  purpose:
    'The nested provider->model Radix submenu previously closed before a model could be selected, making model switching effectively broken; this guards against that regressing',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        'Open "Add to message", drill into Provider -> a provider -> a model using only the keyboard, and select a model',
      expectedOutcome: 'The model chip shows the selected model id',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Repeat, selecting a model from a second, sibling provider',
      expectedOutcome: "The model chip updates to the second provider's selected model",
      test: () => {},
    },
  ],
};

const MOCK_PROVIDERS = {
  providers: [
    {
      name: 'openai',
      type: 'openai',
      defaultModel: 'gpt-4o',
      models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
    },
    {
      name: 'ollama',
      type: 'ollama',
      models: [{ id: 'llama3.2' }],
    },
  ],
  defaultProvider: 'openai',
};

async function mockProvidersApi(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/providers', async (route: Route) => {
    await route.fulfill({ json: MOCK_PROVIDERS });
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('keyboard-only selection of a model from a nested provider submenu updates the model chip', async ({
      page,
    }, testInfo) => {
      await mockProvidersApi(page);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const addTrigger = page.locator('button[aria-label="Add to message"]');
      await addTrigger.press('Enter'); // open "Add to message"

      // Target each level by role/name rather than counting ArrowDown
      // presses between items (Radix's initial-focus-on-open and roving
      // tabindex behavior isn't a stable thing to count blindly) — each
      // press() still focuses the real element and dispatches a genuine
      // keyboard event on it, so this still exercises the real
      // open-via-keyboard path the fix targets, just without a brittle
      // fixed step count.
      await page.getByRole('menuitem', { name: 'Provider' }).press('ArrowRight'); // open Provider submenu
      await page.getByRole('menuitem', { name: 'openai', exact: true }).press('ArrowRight'); // open openai's model list
      await page.getByRole('menuitemcheckbox', { name: 'gpt-4o', exact: true }).press('Enter'); // select

      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('gpt-4o');
    });

    test('selecting a model from a second, sibling provider updates the chip', async ({
      page,
    }, testInfo) => {
      await mockProvidersApi(page);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const addTrigger = page.locator('button[aria-label="Add to message"]');
      await addTrigger.press('Enter');

      await page.getByRole('menuitem', { name: 'Provider' }).press('ArrowRight');
      await page.getByRole('menuitem', { name: 'ollama', exact: true }).press('ArrowRight'); // open ollama's model list
      await page.getByRole('menuitemcheckbox', { name: 'llama3.2', exact: true }).press('Enter');

      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('llama3.2');
    });
  },
);
