import { test, expect, type Route, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 24,
  name: 'Chat Code Block Whitespace & Wrap',
  description:
    'Verifies a fenced code block in a chat message preserves its exact indentation on screen and on copy, in both the default (scroll) and wrap long-line modes',
  purpose:
    'Regression coverage: code blocks previously collapsed leading whitespace via whitespace-pre-line, visually and on copy, breaking whitespace-sensitive content like YAML',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Load a thread whose last message contains an indented YAML code block',
      expectedOutcome:
        'The code block renders with exact indentation and scrolls (does not wrap) long lines by default; Copy writes the unmodified, indented text to the clipboard',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle "Wrap long lines in code blocks" on in Settings → Agent behavior and save',
      expectedOutcome:
        'Back on the thread, the same code block now wraps instead of scrolling, indentation is still exact, and Copy still writes the unmodified, indented text',
      test: () => {},
    },
  ],
};

const THREAD_ID = 'thread-code-block-wrap-test';

const mockThread = {
  id: THREAD_ID,
  title: 'Code Block Wrap Test',
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

// Nested indentation (2- and 4-space levels), matching the shape of the
// originally-reported bug (a docker-compose-style YAML snippet).
const YAML_SNIPPET =
  'services:\n' +
  '  matter-server:\n' +
  '    image: ghcr.io/matter-js/matter-server:1.4\n' +
  '    restart: unless-stopped\n' +
  '    volumes:\n' +
  '      - matter-server-data:/data';

// Fenced code content renders (and copies) with a trailing newline — the
// line before the closing ``` fence — which is normal Markdown behavior,
// not something this fix changes.
const YAML_SNIPPET_WITH_TRAILING_NEWLINE = `${YAML_SNIPPET}\n`;

const messages = [
  {
    kind: 'assistant',
    id: 'assistant-1',
    status: 'done',
    content: 'Here is the config:\n\n```yaml\n' + YAML_SNIPPET + '\n```',
    sentAt: '2026-10-18T10:00:30.000Z',
    seq: 1,
  },
];

async function mockApis(page: Page): Promise<void> {
  await page.route('**/api/v1/threads**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const match = url.pathname.match(/^\/api\/v1\/threads(?:\/([^/]+))?$/);

    if (!match) {
      await route.fallback();
      return;
    }

    const id = match[1];

    if (!id && method === 'GET') {
      await route.fulfill({ json: [mockThread] });
      return;
    }

    if (id === THREAD_ID && method === 'GET') {
      await route.fulfill({ json: { ...mockThread, messages } });
      return;
    }

    await route.fallback();
  });
}

const SAVED_TOAST = { role: 'alert' as const, hasText: 'Settings saved' };

async function setCodeBlockWrap(page: Page, wrap: boolean): Promise<void> {
  await page.goto('/settings?section=agent-behavior');
  await page.waitForSelector('[data-slot="settings-nav-item"]');

  const toggle = page.getByRole('switch', { name: 'Wrap long lines in code blocks' });
  const isChecked = await toggle.isChecked();
  if (isChecked !== wrap) {
    await toggle.click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByRole(SAVED_TOAST.role).filter({ hasText: SAVED_TOAST.hasText }),
    ).toBeVisible();
  }
}

test.describe('Chat Code Block Whitespace & Wrap', { annotation: suiteAnnotations(suite) }, () => {
  // This spec is the only one that flips the real codeBlockWrap setting
  // against the local dev backend (per design, no mock for the settings
  // endpoint itself) — reset it so the change doesn't leak into other specs
  // sharing that backend.
  test.afterEach(async ({ page }) => {
    await setCodeBlockWrap(page, false);
  });

  test('scroll mode preserves exact indentation on screen and on copy @user-workflow', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockApis(page);
    await page.goto(`/chat/${THREAD_ID}`);

    const codeBlock = page.getByTestId('assistant-message').getByTestId('code-block');
    const pre = codeBlock.locator('pre');
    await expect(pre).toBeVisible();
    await expect(pre).toHaveCSS('white-space', 'pre');
    await expect(pre).toContainText('matter-server:');
    expect(await pre.textContent()).toBe(YAML_SNIPPET_WITH_TRAILING_NEWLINE);

    await pauseBeforeAction(page, testInfo);
    await codeBlock.hover();
    await codeBlock.locator('button[aria-label="Copy code"]').click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(YAML_SNIPPET_WITH_TRAILING_NEWLINE);
  });

  test('wrap mode still preserves exact indentation on screen and on copy @user-workflow', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setCodeBlockWrap(page, true);

    await mockApis(page);
    await page.goto(`/chat/${THREAD_ID}`);

    const codeBlock = page.getByTestId('assistant-message').getByTestId('code-block');
    const pre = codeBlock.locator('pre');
    await expect(pre).toBeVisible();
    await expect(pre).toHaveCSS('white-space', 'pre-wrap');
    expect(await pre.textContent()).toBe(YAML_SNIPPET_WITH_TRAILING_NEWLINE);

    await pauseBeforeAction(page, testInfo);
    await codeBlock.hover();
    await codeBlock.locator('button[aria-label="Copy code"]').click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(YAML_SNIPPET_WITH_TRAILING_NEWLINE);
  });
});
