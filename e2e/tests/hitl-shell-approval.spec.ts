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
  question: 'Allow command: `ls -la`\n\nReason: List directory contents',
  promptKind: 'shell_approval',
  command: 'echo line-one\necho line-two\necho line-three',
  reason: 'List directory contents',
};

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
