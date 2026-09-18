import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 11,
  name: 'HITL Shell Approval Hydration',
  description:
    'Verifies that a pending shell_approval HITL prompt hydrates correctly on thread load, rendering Approve/Deny buttons instead of a free-text input',
  purpose:
    'Ensure the shell_approval rendering branch works on reload/reconnect without requiring a live LLM',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load a thread whose last message is a pending shell_approval HITL prompt',
      expectedOutcome:
        'Approve, Approve & remember, and Deny buttons are visible; text input is not',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Approve',
      expectedOutcome: 'The HITL answer is submitted and the chat input re-enables',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'View a shell_approval prompt with a multi-line command and click "View command"',
      expectedOutcome:
        'The reason is shown prominently, only the first line of the command is previewed, ' +
        'and clicking "View command" opens a dialog showing the full multi-line command',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action:
        'Load a shell_approval prompt with a long multi-line command and a long reason on a mobile viewport (375×812)',
      expectedOutcome:
        'Deny/Approve/Approve & remember buttons are all visible within the viewport with no page-level scrolling required',
      test: () => {},
    },
  ],
};

const THREAD_ID = 'thread-hitl-test';

const mockThread = {
  id: THREAD_ID,
  title: 'Shell Approval Test',
  createdAt: '2026-08-06T10:00:00.000Z',
  updatedAt: '2026-08-06T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

const pendingShellPrompt = {
  id: 'prompt-1',
  kind: 'hitl_prompt',
  seq: 2,
  status: 'pending',
  promptId: 'prompt-1',
  question: 'Approve command execution?',
  promptKind: 'shell_approval',
  command: 'echo line-one\necho line-two\necho line-three',
  reason: 'List directory contents',
};

const LONG_THREAD_ID = 'thread-hitl-overflow-test';

const mockLongThread = {
  id: LONG_THREAD_ID,
  title: 'Shell Approval Overflow Test',
  createdAt: '2026-08-06T10:00:00.000Z',
  updatedAt: '2026-08-06T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${LONG_THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${LONG_THREAD_ID}/after-agent-status`,
  },
};

// Intentionally long, multi-line command + a long reason — regression
// coverage for the header-overflow bug: before the fix, a long question
// (or a long embedded command in it) could grow the header tall enough to
// push the action buttons below the mobile viewport.
const longReason =
  'This command rewrites several configuration files across the workspace ' +
  'and should only run if you have already reviewed the diff, backed up ' +
  'any local changes, and understand it will overwrite existing content ' +
  'without prompting for confirmation first.';

const longCommand = Array.from(
  { length: 20 },
  (_, i) => `echo "line ${i + 1} of a very long heredoc payload being written to disk"`,
).join('\n');

const pendingLongShellPrompt = {
  id: 'prompt-overflow-1',
  kind: 'hitl_prompt',
  seq: 2,
  status: 'pending',
  promptId: 'prompt-overflow-1',
  question: 'Approve command execution?',
  promptKind: 'shell_approval',
  command: longCommand,
  reason: longReason,
};

async function mockLongPromptApis(page: import('@playwright/test').Page) {
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
      await route.fulfill({ json: [mockLongThread] });
      return;
    }

    if (id === LONG_THREAD_ID && method === 'GET') {
      await route.fulfill({
        json: { ...mockLongThread, messages: [pendingLongShellPrompt] },
      });
      return;
    }

    await route.fallback();
  });
}

async function mockApis(page: import('@playwright/test').Page) {
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
      await route.fulfill({
        json: { ...mockThread, messages: [pendingShellPrompt] },
      });
      return;
    }

    await route.fallback();
  });

  await page.route(`**/api/v1/chat/${THREAD_ID}/hitl`, async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'data: {"type":"stream_done","durationMs":50}\n\n',
      });
      return;
    }
    await route.fallback();
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('pending shell_approval renders Approve/Deny buttons, not a text input', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto('/');

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'Shell Approval Test' });
      await pauseBeforeAction(page, testInfo);
      await row.click();

      await expect(page.locator('[data-slot="textarea"]')).toBeDisabled({ timeout: 10_000 });

      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve & remember' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
      await expect(page.locator('input[placeholder="Type your answer…"]')).not.toBeVisible();
    });

    test('clicking Approve submits the answer and re-enables the chat input', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto('/');

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'Shell Approval Test' });
      await row.click();

      await expect(page.locator('[data-slot="textarea"]')).toBeDisabled({ timeout: 10_000 });

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();

      await expect(page.locator('[data-slot="textarea"]')).toBeEnabled({ timeout: 10_000 });
    });

    test('reason is shown prominently and View command opens the full command', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto('/');

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'Shell Approval Test' });
      await row.click();

      await expect(page.locator('[data-slot="textarea"]')).toBeDisabled({ timeout: 10_000 });

      await expect(page.getByText('List directory contents', { exact: true })).toBeVisible();
      await expect(page.getByText('echo line-one', { exact: true })).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'View command' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('echo line-two')).toBeVisible();
      await expect(dialog.getByText('echo line-three')).toBeVisible();

      // toBeVisible() resolves before the Modal's 200ms fade/blur-in
      // transition finishes, so the video would otherwise cut off mid
      // transition — hold on the fully-settled dialog so a video viewer
      // can actually see it.
      await pauseBeforeAction(page, testInfo);
    });
  },
);

test.describe('Mobile viewport @smoke', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('a long command/reason does not push the action buttons out of the viewport', async ({
    page,
  }, testInfo) => {
    await mockLongPromptApis(page);
    // The thread sidebar is `hidden lg:block` and only mounts inside a
    // bottom-sheet toggle below that breakpoint, so at this mobile viewport
    // there's no visible thread-row to click — navigate straight to the
    // thread's own route instead, same as clicking a row would.
    await pauseBeforeAction(page, testInfo);
    await page.goto(`/chat/${LONG_THREAD_ID}`);

    await expect(page.locator('[data-slot="textarea"]')).toBeDisabled({ timeout: 10_000 });

    const approveButton = page.getByRole('button', { name: 'Approve', exact: true });
    const approveRememberButton = page.getByRole('button', { name: 'Approve & remember' });
    const denyButton = page.getByRole('button', { name: 'Deny' });

    await expect(approveButton).toBeVisible();
    await expect(approveRememberButton).toBeVisible();
    await expect(denyButton).toBeVisible();

    const viewport = page.viewportSize();
    if (!viewport) throw new Error('missing viewport size');

    for (const button of [denyButton, approveRememberButton, approveButton]) {
      const box = await button.boundingBox();
      if (!box) throw new Error('missing bounding box for action button');
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }

    // The page itself must not need scrolling to reach the buttons — only
    // the header's internal max-h-32 overflow-y-auto box may scroll.
    const bodyScrollHeight = await page.evaluate(() => document.body.scrollHeight);
    expect(bodyScrollHeight).toBeLessThanOrEqual(viewport.height + 1);
  });
});
