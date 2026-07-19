import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 10,
  name: 'AfterAgent Status Indicator',
  description:
    'Verifies the sidebar (and composer) AfterAgent status indicator renders correctly for each afterAgentState value, against a mocked /api/v1/threads backend',
  purpose:
    'Ensure the background-pipeline status indicator reads correctly at a glance without depending on a live LLM or a real AfterAgent run',
  tags: ['@smoke'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load / with a thread whose afterAgentState is "running"',
      expectedOutcome: 'The sidebar row shows a spinner in place of the kebab menu',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load / with a thread whose afterAgentState is "done"/"identified"',
      expectedOutcome: 'The sidebar row shows a success-colored checkmark',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Load / with a thread whose afterAgentState is "idle"',
      expectedOutcome: 'The sidebar row shows the normal kebab menu, no indicator',
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
  afterAgentState:
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; outcome: 'identified' | 'no-op' | 'error'; finishedAt: string };
  links: { self: string; afterAgentStatus: string };
}

function mockThread(
  id: string,
  title: string,
  afterAgentState: MockThread['afterAgentState'],
): MockThread {
  return {
    id,
    title,
    createdAt: '2026-07-19T10:00:00.000Z',
    updatedAt: '2026-07-19T10:05:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    afterAgentState,
    links: {
      self: `/api/v1/threads/${id}`,
      afterAgentStatus: `/api/v1/threads/${id}/after-agent-status`,
    },
  };
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

    await route.fallback();
  });
}

function rowFor(page: import('@playwright/test').Page, title: string) {
  return page.locator('[data-slot="thread-row"]').filter({ hasText: title });
}

test.describe(
  '@smoke',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('a "running" thread shows a spinner in place of the kebab menu', async ({
      page,
    }, testInfo) => {
      await mockThreadsApi(page, [
        mockThread('t-running', 'Working thread', { status: 'running' }),
      ]);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = rowFor(page, 'Working thread');
      await expect(row.locator('svg.animate-spin')).toBeVisible();
      await expect(row.locator('button[aria-haspopup="menu"]')).not.toBeVisible();
    });

    test('a "done"/"identified" thread shows a success-colored checkmark', async ({
      page,
    }, testInfo) => {
      await mockThreadsApi(page, [
        mockThread('t-identified', 'Identified thread', {
          status: 'done',
          outcome: 'identified',
          finishedAt: new Date().toISOString(),
        }),
      ]);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = rowFor(page, 'Identified thread');
      await expect(row.locator('.text-success')).toBeVisible();
    });

    test('a "done"/"error" thread shows a destructive-colored warning icon', async ({
      page,
    }, testInfo) => {
      await mockThreadsApi(page, [
        mockThread('t-error', 'Errored thread', {
          status: 'done',
          outcome: 'error',
          finishedAt: new Date().toISOString(),
        }),
      ]);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = rowFor(page, 'Errored thread');
      await expect(row.locator('.text-destructive')).toBeVisible();
    });

    test('an "idle" thread shows the normal kebab menu, no indicator', async ({
      page,
    }, testInfo) => {
      await mockThreadsApi(page, [mockThread('t-idle', 'Idle thread', { status: 'idle' })]);
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const row = rowFor(page, 'Idle thread');
      await expect(row.locator('button[aria-haspopup="menu"]')).toBeAttached();
      await expect(row.locator('svg.animate-spin')).toHaveCount(0);
      await expect(row.locator('.text-success')).toHaveCount(0);
      await expect(row.locator('.text-destructive')).toHaveCount(0);
    });
  },
);
