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

// A real keyboard user has reaction/movement time between key presses —
// pressing the next arrow key within single-digit milliseconds of the last
// (as Playwright does with a bare loop of page.keyboard.press() calls) can
// outrun Radix's own auto-focus-on-open handling and desync which item is
// actually focused. 120ms approximates an unhurried but deliberate press.
async function pressKey(page: import('@playwright/test').Page, key: string) {
  await page.keyboard.press(key);
  await page.waitForTimeout(120);
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
      await addTrigger.focus();

      // Genuine roving-focus keyboard navigation — every step is a real
      // key event dispatched on whatever currently has focus, exercising
      // Radix's own focus-travel exactly as a real keyboard user would.
      // Deliberately NOT using locator.press() on specific target elements:
      // that programmatically re-focuses each element before dispatching
      // the key, which bypasses Radix's roving-tabindex mechanism entirely
      // and previously hid a real regression (issue #113 follow-up) where
      // navigating this way, for real, collapsed the whole menu.
      await pressKey(page, 'Enter'); // open "Add to message"
      await pressKey(page, 'ArrowDown'); // -> "Add file"
      await pressKey(page, 'ArrowDown'); // -> "Provider"
      await pressKey(page, 'ArrowRight'); // open Provider submenu
      await pressKey(page, 'ArrowDown'); // -> "openai"
      await pressKey(page, 'ArrowRight'); // open openai's model list
      await pressKey(page, 'ArrowDown'); // -> "gpt-4o"
      await pressKey(page, 'Enter'); // select

      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('gpt-4o');
    });

    test('selecting a model from a second, sibling provider updates the chip', async ({
      page,
    }, testInfo) => {
      await mockProvidersApi(page);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const addTrigger = page.locator('button[aria-label="Add to message"]');
      await addTrigger.focus();

      await pressKey(page, 'Enter');
      await pressKey(page, 'ArrowDown'); // -> "Add file"
      await pressKey(page, 'ArrowDown'); // -> "Provider"
      await pressKey(page, 'ArrowRight');
      await pressKey(page, 'ArrowDown'); // -> "openai"
      await pressKey(page, 'ArrowDown'); // -> "ollama"
      await pressKey(page, 'ArrowRight'); // open ollama's model list
      await pressKey(page, 'ArrowDown'); // -> "llama3.2"
      await pressKey(page, 'Enter');

      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('llama3.2');
    });
  },
);
