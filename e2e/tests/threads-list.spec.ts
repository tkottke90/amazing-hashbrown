import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 50,
  name: 'Threads List',
  description:
    'Verifies the /threads page lists threads of every type and lets a user filter them and open their report',
  purpose:
    'Finding a given thread (especially a task-run thread, which has no other list) depends on this page working correctly',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Navigate to /threads from the sidebar link',
      expectedOutcome: 'The page loads and lists one row per seeded thread, across all 4 types',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click a type filter tab',
      expectedOutcome: 'Only rows of that thread type remain visible',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Click a row's Generate thread report button",
      expectedOutcome: 'A new tab opens showing the mocked HTML report for that row',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click the Archived filter tab, then Unarchive a row',
      expectedOutcome:
        "Only archived rows show under that tab, and Unarchive clears a row's Archived badge",
      test: () => {},
    },
  ],
};

const REPORT_HTML = `<!DOCTYPE html><html><body><h1>Thread Report</h1></body></html>`;

interface MockThread {
  id: string;
  title: string;
  type: 'chat' | 'wiki' | 'workspace-chat' | 'task';
  createdAt: string;
  updatedAt: string;
  forkedFromThreadId: null;
  forkedFromSeq: null;
  afterAgentState: { status: 'idle' };
  links: { self: string; afterAgentStatus: string };
  provider: null;
  model: null;
  archivedAt: string | null;
}

function makeThread(
  id: string,
  title: string,
  type: MockThread['type'],
  archivedAt: string | null = null,
): MockThread {
  return {
    id,
    title,
    type,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    afterAgentState: { status: 'idle' },
    links: {
      self: `/api/v1/threads/${id}`,
      afterAgentStatus: `/api/v1/threads/${id}/after-agent-status`,
    },
    provider: null,
    model: null,
    archivedAt,
  };
}

const SEEDED_THREADS: MockThread[] = [
  makeThread('chat-1', 'A chat conversation', 'chat'),
  makeThread('wiki-1', 'Wiki ingestion', 'wiki'),
  makeThread('ws-chat-1', 'Workspace chat', 'workspace-chat'),
  makeThread('task-1', 'Weekly audit run', 'task'),
  makeThread('archived-chat-1', 'Old project planning', 'chat', '2026-10-01T00:00:00.000Z'),
];

async function mockThreadsListApi(
  page: import('@playwright/test').Page,
  threads: MockThread[] = SEEDED_THREADS,
): Promise<void> {
  await page.route('**/api/v1/threads**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const match = url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/(archive|unarchive)$/);

    if (match) {
      const [, id, action] = match;
      const thread = threads.find((t) => t.id === id);
      if (!thread) {
        await route.fulfill({ status: 404, json: { error: 'not found' } });
        return;
      }
      thread.archivedAt = action === 'archive' ? '2026-10-20T00:00:00.000Z' : null;
      await route.fulfill({ json: thread });
      return;
    }

    if (url.pathname !== '/api/v1/threads') {
      await route.fallback();
      return;
    }
    const type = url.searchParams.get('type');
    if (type === 'all') {
      await route.fulfill({ json: threads });
      return;
    }
    // The main chat sidebar's own default-filtered fetch — no threads
    // needed for this suite, just enough to not error.
    await route.fulfill({ json: [] });
  });
}

async function mockReportEndpoint(page: import('@playwright/test').Page): Promise<void> {
  await page.context().route('**/api/v1/threads/*/report', async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: REPORT_HTML,
    });
  });
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('lists one row per thread type and navigates there from the sidebar', async ({
      page,
    }, testInfo) => {
      await mockThreadsListApi(page);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('link', { name: 'Threads' }).click();
      await expect(page).toHaveURL(/\/threads$/);

      await expect(page.getByTestId('thread-row')).toHaveCount(5);
      await expect(page.getByText('A chat conversation')).toBeVisible();
      await expect(page.getByText('Wiki ingestion')).toBeVisible();
      await expect(page.getByText('Workspace chat')).toBeVisible();
      await expect(page.getByText('Weekly audit run')).toBeVisible();
      await expect(page.getByText('Old project planning')).toBeVisible();
    });

    test('a filter tab narrows the list to one thread type', async ({ page }, testInfo) => {
      await mockThreadsListApi(page);
      await page.goto('/threads');
      await pauseBeforeAction(page, testInfo);

      await expect(page.getByTestId('thread-row')).toHaveCount(5);
      await page.getByRole('button', { name: 'Wiki' }).click();

      await expect(page.getByTestId('thread-row')).toHaveCount(1);
      await expect(page.getByText('Wiki ingestion')).toBeVisible();
    });

    test("a row's generate report button opens HTML in a new tab", async ({ page }, testInfo) => {
      await mockThreadsListApi(page);
      await mockReportEndpoint(page);
      await page.goto('/threads');
      await pauseBeforeAction(page, testInfo);

      const row = page.getByTestId('thread-row').filter({ hasText: 'Weekly audit run' });
      const newPagePromise = page.context().waitForEvent('page');
      await row.getByTitle('Generate thread report').click();
      const reportPage = await newPagePromise;

      await reportPage.waitForLoadState();
      await expect(reportPage.locator('h1')).toHaveText('Thread Report');
    });

    test('the Archived filter tab narrows the list to only archived threads', async ({
      page,
    }, testInfo) => {
      await mockThreadsListApi(page);
      await page.goto('/threads');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('button', { name: 'Archived' }).click();

      await expect(page.getByTestId('thread-row')).toHaveCount(1);
      await expect(page.getByText('Old project planning')).toBeVisible();
    });

    test('the Actions column only offers Archive/Unarchive for chat-type rows', async ({
      page,
    }, testInfo) => {
      await mockThreadsListApi(page);
      await page.goto('/threads');
      await pauseBeforeAction(page, testInfo);

      const chatRow = page.getByTestId('thread-row').filter({ hasText: 'A chat conversation' });
      await expect(chatRow.getByRole('button', { name: 'Archive' })).toBeVisible();

      const wikiRow = page.getByTestId('thread-row').filter({ hasText: 'Wiki ingestion' });
      await expect(wikiRow.getByRole('button', { name: 'Archive' })).toHaveCount(0);
      await expect(wikiRow.getByRole('button', { name: 'Unarchive' })).toHaveCount(0);
    });

    test("Unarchive clears a row's Archived badge and re-enables Archive", async ({
      page,
    }, testInfo) => {
      const threads = SEEDED_THREADS.map((t) => ({ ...t }));
      await mockThreadsListApi(page, threads);
      await page.goto('/threads');
      await pauseBeforeAction(page, testInfo);

      const row = page.getByTestId('thread-row').filter({ hasText: 'Old project planning' });
      await expect(row.getByText('Archived')).toBeVisible();

      await row.getByRole('button', { name: 'Unarchive' }).click();

      await expect(row.getByText('Archived')).not.toBeVisible();
      await expect(row.getByRole('button', { name: 'Archive' })).toBeVisible();
    });
  },
);
