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
    {
      tags: ['@smoke'],
      action:
        'Open the menu with the mouse, hover into a model list, linger, then move the cursor between two models before clicking one',
      expectedOutcome:
        'The menu stays open through the linger and the move, and the model chip shows the clicked model',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action:
        'On a mobile viewport, tap through "Add to message" -> "Provider" -> a provider, then tap a model in the resulting bottom sheet',
      expectedOutcome:
        "The provider tap stays open long enough for a real tap, the sheet opens with that provider's models, and the model chip shows the tapped model",
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action:
        'On a mobile viewport, open the model sheet for a provider with a long, unbroken model name (e.g. a GGUF filename)',
      expectedOutcome:
        'The model row and the sheet panel itself both stay within the viewport bounds instead of overflowing off-screen, and tapping the long-named model still updates the chip',
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

// A separate fixture (rather than a third entry on MOCK_PROVIDERS) for the
// long-model-name overflow test below: the keyboard tests' ArrowDown counts
// depend on the exact provider list length (Radix's roving focus clamps at
// the last item rather than wrapping), so widening the shared fixture would
// silently change which provider a fixed number of ArrowDown presses lands
// on elsewhere in this file.
const MOCK_PROVIDERS_WITH_LONG_MODEL_NAME = {
  providers: [
    ...MOCK_PROVIDERS.providers,
    {
      name: 'local-gguf',
      type: 'openai-compatible',
      models: [{ id: 'Meta-Llama-3.1-70B-Instruct-Q4_K_M-00001-of-00002.gguf' }],
    },
  ],
  defaultProvider: 'openai',
};

async function mockProvidersApi(
  page: import('@playwright/test').Page,
  providers: typeof MOCK_PROVIDERS | typeof MOCK_PROVIDERS_WITH_LONG_MODEL_NAME = MOCK_PROVIDERS,
) {
  await page.route('**/api/v1/providers', async (route: Route) => {
    await route.fulfill({ json: providers });
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
      await pressKey(page, 'ArrowDown'); // -> "Edit tools" (issue #171)
      await pressKey(page, 'ArrowDown'); // -> "Provider"
      await pressKey(page, 'ArrowRight'); // open Provider submenu, auto-focuses "openai"
      await pressKey(page, 'ArrowRight'); // open openai's model list, auto-focuses "gpt-4o"
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
      await pressKey(page, 'ArrowDown'); // -> "Edit tools" (issue #171)
      await pressKey(page, 'ArrowDown'); // -> "Provider"
      await pressKey(page, 'ArrowRight');
      await pressKey(page, 'ArrowDown'); // -> "openai"
      await pressKey(page, 'ArrowDown'); // -> "ollama"
      await pressKey(page, 'ArrowRight'); // open ollama's model list
      await pressKey(page, 'ArrowDown'); // -> "llama3.2"
      await pressKey(page, 'Enter');

      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('llama3.2');
    });

    test('mouse: lingering in and moving within an open model list does not close the menu', async ({
      page,
    }, testInfo) => {
      await mockProvidersApi(page);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await page.locator('button[aria-label="Add to message"]').click();
      await page.getByRole('menuitem', { name: 'Provider' }).hover();
      const openaiTrigger = page.getByRole('menuitem', { name: 'openai', exact: true });
      await openaiTrigger.hover();

      const firstModel = page.getByRole('menuitemcheckbox', { name: 'gpt-4o', exact: true });
      await expect(firstModel).toBeVisible();

      // Move onto the first model in several discrete steps, matching a
      // real cursor's speed rather than Playwright's near-instant default —
      // this is what actually exposed the bug: an unhurried move stayed
      // well clear of the fix's grace window, while a fast synthetic one
      // didn't.
      const triggerBox = await openaiTrigger.boundingBox();
      const firstModelBox = await firstModel.boundingBox();
      if (!triggerBox || !firstModelBox) throw new Error('missing bounding box');
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(
          triggerBox.x + ((firstModelBox.x - triggerBox.x) * i) / 6,
          triggerBox.y + ((firstModelBox.y - triggerBox.y) * i) / 6,
        );
        await page.waitForTimeout(50);
      }
      await expect(firstModel).toBeVisible();

      // Linger — the model list's own trigger/content are still under the
      // cursor's neighborhood, but the outer "Provider" menu's own DOM
      // nodes are not; this is the exact gap the fix closes (a provider's
      // model list is a separately-portaled subtree, so the outer menu's
      // own pointer-leave already fired on the way in).
      await page.waitForTimeout(300);
      await expect(firstModel).toBeVisible();

      // Move within the open content to a sibling model, well past the
      // grace window since first arriving.
      const secondModel = page.getByRole('menuitemcheckbox', { name: 'gpt-4o-mini', exact: true });
      const secondModelBox = await secondModel.boundingBox();
      if (!secondModelBox) throw new Error('missing bounding box for second model');
      await page.mouse.move(
        secondModelBox.x + secondModelBox.width / 2,
        secondModelBox.y + secondModelBox.height / 2,
        { steps: 10 },
      );
      await page.waitForTimeout(300);
      await expect(secondModel).toBeVisible();

      await secondModel.click();
      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('gpt-4o-mini');
    });
  },
);

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    // 420x874 mirrors a typical modern phone in portrait. hasTouch/isMobile
    // are context-level options — they can't be toggled per-test, which is
    // why this mobile variant lives in its own describe() rather than
    // reusing the desktop block above.
    test.use({ viewport: { width: 420, height: 874 }, hasTouch: true, isMobile: true });

    test('touch: tapping through Add to message -> Provider -> a provider opens a bottom sheet, and tapping a model there selects it', async ({
      page,
    }, testInfo) => {
      await mockProvidersApi(page);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await page.locator('button[aria-label="Add to message"]').tap();

      const providerTrigger = page.getByRole('menuitem', { name: 'Provider' });
      await expect(providerTrigger).toBeVisible();
      await providerTrigger.tap();

      // On a mobile viewport, a provider is a flat tappable item (not a
      // nested flyout trigger) — the model list it used to open as a
      // second-level flyout overflowed the viewport when model names were
      // long (see the long-name test below), so tapping a provider here
      // closes the whole "Add to message" menu and opens a BottomSheet
      // with that provider's models instead.
      const openaiItem = page.getByRole('menuitem', { name: 'openai', exact: true });
      await expect(openaiItem).toBeVisible();

      // A real finger needs a moment to lift off "Provider" and land on
      // "openai" — long enough to expose the same premature-close race the
      // mouse-hover regression test above guards against (issue #113), only
      // this time via touch's pointerup/pointerleave sequence rather than a
      // mouse move.
      await page.waitForTimeout(250);
      await expect(openaiItem).toBeVisible();
      await openaiItem.tap();

      const firstModel = page.getByRole('button', { name: 'gpt-4o', exact: true });
      await expect(firstModel).toBeVisible();
      await expect(providerTrigger).not.toBeVisible();

      await page.waitForTimeout(250);
      await expect(firstModel).toBeVisible();

      // Linger, matching the mouse test's "read the model list before
      // tapping" scenario above — a real user's tap isn't instantaneous,
      // and this is what actually caught the #113 regression for mouse.
      await page.waitForTimeout(300);
      await expect(firstModel).toBeVisible();
      await firstModel.tap();

      await expect(page.locator('[data-slot="model-chip"]')).toHaveText('gpt-4o');
    });

    // Regression coverage: the nested flyout this bottom sheet replaced
    // overflowed the viewport when a model's name was a long, unbroken
    // string (e.g. a real GGUF quant filename) — Radix positions a
    // SubContent flyout relative to its trigger without reflowing long
    // text, so on a narrow viewport it rendered partially off-screen and
    // became unusable. The BottomSheet is full-width and wraps/scrolls
    // instead, so this asserts the sheet and its long-named row both stay
    // within the viewport, and the flow is still fully usable.
    test('touch: a long, unbroken model name does not overflow the viewport and stays tappable', async ({
      page,
    }, testInfo) => {
      await mockProvidersApi(page, MOCK_PROVIDERS_WITH_LONG_MODEL_NAME);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await page.locator('button[aria-label="Add to message"]').tap();
      await page.getByRole('menuitem', { name: 'Provider' }).tap();

      const providerItem = page.getByRole('menuitem', { name: 'local-gguf', exact: true });
      await expect(providerItem).toBeVisible();
      await providerItem.tap();

      const longModelName = 'Meta-Llama-3.1-70B-Instruct-Q4_K_M-00001-of-00002.gguf';
      const longModel = page.getByRole('button', { name: longModelName, exact: true });
      await expect(longModel).toBeVisible();

      const viewport = page.viewportSize();
      if (!viewport) throw new Error('missing viewport size');

      const modelBox = await longModel.boundingBox();
      if (!modelBox) throw new Error('missing bounding box for long model row');
      expect(modelBox.x).toBeGreaterThanOrEqual(0);
      expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(viewport.width);

      const sheetPanel = page.locator('dialog[open]').last();
      const sheetBox = await sheetPanel.boundingBox();
      if (!sheetBox) throw new Error('missing bounding box for sheet panel');
      expect(sheetBox.x).toBeGreaterThanOrEqual(0);
      expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(viewport.width);
      // Capped at 80vh — a couple of pixels of slack for sub-pixel rounding.
      expect(sheetBox.height).toBeLessThanOrEqual(viewport.height * 0.8 + 2);

      await longModel.tap();
      await expect(page.locator('[data-slot="model-chip"]')).toHaveText(longModelName);
    });
  },
);
