import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';
import { gotoNewChat } from '../lib/chat.js';

const suite: TestSuite = {
  id: 59,
  name: 'Mobile Chat Input Enter Key',
  description:
    'Verifies that on a coarse-pointer (touch) device, a bare Enter in the chat composer inserts a newline instead of sending — regression coverage for issue #396',
  purpose:
    'Most mobile on-screen keyboards give no practical way to hold Shift while tapping Enter, so the desktop Enter-always-sends behavior silently sent in-progress messages or garbled multi-line pastes on mobile; this guards against that regressing',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'On a touch viewport, type text and press Enter with no menu open',
      expectedOutcome: 'A newline is inserted into the composer and the message is not sent',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Paste multi-line clipboard content into the composer via a real native paste',
      expectedOutcome:
        'The message is not sent prematurely and all line breaks are preserved in the textarea value',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the #tool-name menu and press Enter to confirm the highlighted item',
      expectedOutcome:
        'The menu still confirms via Enter on a touch context, exactly as on desktop (D5)',
      test: () => {},
    },
  ],
};

// Reuses the exact route glob already established in thread-tools.spec.ts
// for the GET /tools endpoint (ui/src/services/tool-settings-api.ts).
async function mockThreadToolsApi(page: Page) {
  await page.route('**/api/v1/threads/*/tools**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: {
        customized: false,
        tools: [
          {
            toolId: 'web_fetch',
            name: 'Web Fetch',
            description: 'Fetches a URL and returns its content.',
            category: 'built-in',
            alwaysOn: false,
            mcpServer: null,
            lastSeenAt: null,
            lastStatus: null,
            enabled: true,
            defaultInclude: { chat: true, subAgent: true, autonomous: true },
            instructions: '',
            selected: true,
          },
        ],
      },
    });
  });
}

// Desktop (non-coarse-pointer) Enter-sends behavior is explicitly NOT
// retested here (D7) — thread-persistence.spec.ts and thread-sidebar.spec.ts
// already cover it; continuing to pass them is the regression check.
test.describe('@user-workflow', { annotation: suiteAnnotations(suite) }, () => {
  // Context-level options (hasTouch/isMobile) can't be toggled per-test,
  // hence their own describe — same pattern as chat-model-picker.spec.ts.
  test.use({ viewport: { width: 420, height: 874 }, hasTouch: true, isMobile: true });

  test('touch: Enter with no menu open inserts a newline and does not send', async ({
    page,
  }, testInfo) => {
    await gotoNewChat(page);
    await pauseBeforeAction(page, testInfo);

    const textarea = page.locator('[data-slot="textarea"]');
    await textarea.tap();
    await textarea.fill('line one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('line two');

    await expect(textarea).toHaveValue('line one\nline two');
    await expect(page.locator('[data-slot="chat-message"][data-mirrored]')).not.toBeVisible();
    await expect(page.locator('button[aria-label="Send message"]')).toBeEnabled();
  });

  test('touch: a multi-line clipboard paste preserves line breaks and does not send prematurely', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await gotoNewChat(page);
    await pauseBeforeAction(page, testInfo);

    const MULTI_LINE_TEXT = 'line one\nline two\nline three';
    await page.evaluate((text) => navigator.clipboard.writeText(text), MULTI_LINE_TEXT);

    const textarea = page.locator('[data-slot="textarea"]');
    await textarea.tap();
    await page.keyboard.press('Control+v');

    await expect(textarea).toHaveValue(MULTI_LINE_TEXT);
    await expect(page.locator('[data-slot="chat-message"][data-mirrored]')).not.toBeVisible();
  });

  test('touch: #tool-name menu still confirms the highlighted item on Enter', async ({
    page,
  }, testInfo) => {
    await mockThreadToolsApi(page);
    await gotoNewChat(page);
    await pauseBeforeAction(page, testInfo);

    const textarea = page.locator('[data-slot="textarea"]');
    await textarea.tap();
    await textarea.fill('please use #web');

    await expect(page.getByText('#web_fetch')).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(textarea).toHaveValue('please use #web_fetch ');
    await expect(page.getByText('#web_fetch')).not.toBeVisible();
  });
});
