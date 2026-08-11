import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 15,
  name: 'Thread Report',
  description:
    'Verifies the Generate Thread Report button opens an HTML report in a new browser tab, for both the thread sidebar and the wiki chat header',
  purpose:
    'Ensure the report button wires up correctly to the API endpoint and that the response is displayed in a new tab without requiring a live database',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action:
        'Open the kebab menu on a thread row and click Generate thread report',
      expectedOutcome:
        'A new tab opens and displays the mocked HTML report content',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click the Generate thread report icon button in the wiki chat header',
      expectedOutcome:
        'A new tab opens and displays the mocked HTML report content',
      test: () => {},
    },
  ],
};

const REPORT_HTML = `<!DOCTYPE html><html><body><h1>Thread Report</h1></body></html>`;

const WIKI_THREAD_ID = 'wiki-thread-test';

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
  ];
}

async function mockThreadsApi(
  page: import('@playwright/test').Page,
  threads: MockThread[],
): Promise<void> {
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

    await route.fallback();
  });
}

// Registered on context (not page) so the popup page's navigation is intercepted.
async function mockReportEndpoint(
  page: import('@playwright/test').Page,
  threadId: string,
): Promise<void> {
  await page.context().route(`**/api/v1/threads/${threadId}/report`, async (route: Route) => {
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
    test('thread sidebar: generate report opens HTML in a new tab', async ({ page }, testInfo) => {
      await mockThreadsApi(page, seedThreads());
      await mockReportEndpoint(page, 'thread-a');
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = page
        .locator('[data-slot="thread-row"]')
        .filter({ hasText: 'First conversation' });
      await row.hover();
      await row.locator('button[aria-haspopup="menu"]').click();

      const newPagePromise = page.context().waitForEvent('page');
      await page.getByRole('menuitem', { name: 'Generate thread report' }).click();
      const reportPage = await newPagePromise;

      await reportPage.waitForLoadState();
      await expect(reportPage.locator('h1')).toHaveText('Thread Report');
    });

    test('wiki chat: generate report button opens HTML in a new tab', async ({ page }, testInfo) => {
      await page.addInitScript((id: string) => {
        localStorage.setItem('ah-wiki-thread-id', id);
      }, WIKI_THREAD_ID);
      await mockReportEndpoint(page, WIKI_THREAD_ID);
      await page.goto('/wiki');
      await pauseBeforeAction(page, testInfo);

      const newPagePromise = page.context().waitForEvent('page');
      await page.getByRole('button', { name: 'Generate thread report' }).click();
      const reportPage = await newPagePromise;

      await reportPage.waitForLoadState();
      await expect(reportPage.locator('h1')).toHaveText('Thread Report');
    });
  },
);
