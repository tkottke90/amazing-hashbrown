import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 7,
  name: 'Thread Sidebar',
  description:
    'Verifies sidebar thread listing, switching, rename, and delete against a mocked /api/v1/threads backend',
  purpose:
    'Ensure the sidebar CRUD interactions render and wire up correctly without depending on a live LLM',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load / with two mocked threads',
      expectedOutcome: 'Both thread titles render in the sidebar',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click a thread row',
      expectedOutcome: 'The row is highlighted active and its messages hydrate',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the kebab menu and click Rename, type a new title, press Enter',
      expectedOutcome: 'PATCH is sent and the sidebar shows the new title',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the kebab menu and click Delete, then confirm',
      expectedOutcome: 'DELETE is sent and the row disappears from the sidebar',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the kebab menu and click Copy thread ID',
      expectedOutcome: "The thread's id is written to the clipboard",
      test: () => {},
    },
  ],
};

interface MockThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  forkedFromThreadId: string | null;
  forkedFromSeq: number | null;
  afterAgentState: { status: 'idle' };
  links: { self: string; afterAgentStatus: string };
}

function afterAgentFields(id: string): Pick<MockThread, 'afterAgentState' | 'links'> {
  return {
    afterAgentState: { status: 'idle' },
    links: {
      self: `/api/v1/threads/${id}`,
      afterAgentStatus: `/api/v1/threads/${id}/after-agent-status`,
    },
  };
}

function seedThreads(): MockThread[] {
  return [
    {
      id: 'thread-a',
      title: 'First conversation',
      createdAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:05:00.000Z',
      forkedFromThreadId: null,
      forkedFromSeq: null,
      ...afterAgentFields('thread-a'),
    },
    {
      id: 'thread-b',
      title: 'Second conversation',
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T09:05:00.000Z',
      forkedFromThreadId: null,
      forkedFromSeq: null,
      ...afterAgentFields('thread-b'),
    },
  ];
}

async function mockThreadsApi(page: import('@playwright/test').Page, threads: MockThread[]) {
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
      await route.fulfill({ json: threads });
      return;
    }

    if (id && method === 'GET') {
      const thread = threads.find((t) => t.id === id);
      if (!thread) {
        await route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      await route.fulfill({ json: { ...thread, messages: [] } });
      return;
    }

    if (id && method === 'PATCH') {
      const body = route.request().postDataJSON() as { title: string };
      const thread = threads.find((t) => t.id === id);
      if (!thread) {
        await route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      thread.title = body.title;
      await route.fulfill({ json: thread });
      return;
    }

    if (id && method === 'DELETE') {
      const idx = threads.findIndex((t) => t.id === id);
      if (idx === -1) {
        await route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      threads.splice(idx, 1);
      await route.fulfill({ status: 204, body: '' });
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
    test('sidebar renders both mocked threads', async ({ page }, testInfo) => {
      await mockThreadsApi(page, seedThreads());
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const sidebar = page.locator('aside[aria-label="Sidebar navigation"]');
      await expect(sidebar.getByText('First conversation')).toBeVisible();
      await expect(sidebar.getByText('Second conversation')).toBeVisible();
    });

    test('clicking a row switches the active thread', async ({ page }, testInfo) => {
      await mockThreadsApi(page, seedThreads());
      await page.goto('/');

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'Second conversation' });
      await pauseBeforeAction(page, testInfo);
      await row.click();
      await expect(row).toHaveAttribute('data-active', 'true');
    });

    test('rename via kebab menu updates the sidebar title', async ({ page }, testInfo) => {
      await mockThreadsApi(page, seedThreads());
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'First conversation' });
      await row.hover();
      await row.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();

      // The row's data-slot wrapper is replaced by a plain edit-mode div while
      // renaming, so `row` no longer matches — locate the input at the
      // sidebar level instead (only one row can be editing at a time).
      const input = page.locator('aside[aria-label="Sidebar navigation"] input');
      await input.fill('Renamed conversation');
      await input.press('Enter');

      await expect(
        page.locator('[data-slot="thread-row"]').filter({ hasText: 'Renamed conversation' }),
      ).toBeVisible();
    });

    test('delete via kebab menu shows an inline confirm, then removes the row', async ({
      page,
    }, testInfo) => {
      await mockThreadsApi(page, seedThreads());
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'Second conversation' });
      await row.hover();
      await row.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();

      await expect(page.getByText('Delete this thread?')).toBeVisible();

      await page.getByRole('button', { name: 'Confirm delete' }).click();

      await expect(page.getByText('Second conversation')).not.toBeVisible();
      await expect(page.getByText('First conversation')).toBeVisible();
    });

    test('copy thread ID via kebab menu writes the id to the clipboard', async ({
      page,
      context,
    }, testInfo) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await mockThreadsApi(page, seedThreads());
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'First conversation' });
      await row.hover();
      await row.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Copy thread ID' }).click();

      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe('thread-a');
    });
  },
);
