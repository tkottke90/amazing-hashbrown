import {
  test,
  expect,
  type Route,
  type Page,
  type Locator,
  type APIRequestContext,
} from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 49,
  name: 'Mobile Input Zoom (issue #397)',
  description:
    'Verifies that representative previously-broken native form controls (a patched ' +
    '<select>, a migrated Textarea, and a migrated Input) render at a real computed ' +
    'font-size of at least 16px at a mobile viewport, so iOS Safari does not zoom the page ' +
    'on focus',
  purpose:
    "jsdom (this repo's Jest environment) does not execute real CSS/media-query layout, so " +
    'only a real-browser check can prove the fix actually renders at the mobile-safe size, ' +
    'rather than just carrying the right className string. Scope deliberately excludes the ' +
    "chat textarea's own still-unexplained zoom (design spec D5) — this suite only covers " +
    'the controls this fix actually touches',
  tags: ['@smoke'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Open a task drawer\'s "Move to" lane picker (a patched native <select>) at 375px',
      expectedOutcome: 'Its computed font-size is at least 16px',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: "Open a handed-off task's Hand-Off Guidance field (a migrated Textarea) at 375px",
      expectedOutcome: 'Its computed font-size is at least 16px',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Open the wiki "New Page" form\'s title field (a migrated Input) at 375px',
      expectedOutcome: 'Its computed font-size is at least 16px',
      test: () => {},
    },
  ],
};

async function computedFontSizePx(locator: Locator): Promise<number> {
  const value = await locator.evaluate((el) => getComputedStyle(el).fontSize);
  return parseFloat(value);
}

const createdWorkspaceIds: string[] = [];

// Unique per run, so a local rerun against the same data never collides with
// a workspace (or its temp directory) from a previous run.
async function createWorkspace(request: APIRequestContext, name: string) {
  const slug = `${name}-${Date.now()}`;
  const res = await request.post('/api/v1/workspaces', {
    data: { name: slug, locationRoot: 'temporary', directoryName: slug },
  });
  expect(res.status(), 'workspace created').toBe(201);
  const ws = (await res.json()) as { id: string };
  createdWorkspaceIds.push(ws.id);
  return ws;
}

async function createTask(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post('/api/v1/tasks', { data });
  expect(res.status(), 'task created').toBe(201);
  return (await res.json()) as { id: string };
}

test.afterEach(async ({ request }) => {
  for (const id of createdWorkspaceIds.splice(0)) {
    await request.delete(`/api/v1/workspaces/${id}`);
  }
});

// Mocks only the one run-history endpoint needed to put a task's drawer into
// its "handed off" rendering branch (hand-off-guidance.spec.ts's pattern) —
// the task itself is created for real via the API.
async function mockHandedOffRun(page: Page, taskId: string) {
  await page.route(`**/api/v1/tasks/${taskId}/runs**`, async (route: Route) => {
    await route.fulfill({
      json: [
        {
          id: 'e2e-mobile-zoom-run-1',
          taskId,
          status: 'handed_off',
          position: 1,
          enqueuedAt: '2026-11-05T00:00:00.000Z',
          startedAt: '2026-11-05T00:00:00.000Z',
          finishedAt: '2026-11-05T00:05:00.000Z',
          recoveryAttempts: 0,
          threadId: 'e2e-mobile-zoom-run-thread-1',
          summary: 'Ran out of steps.',
          triggerSource: 'manual',
          scheduledFor: null,
          handoffReason: 'exhaustion_cap',
          runNumber: 1,
        },
      ],
    });
  });
}

// Mocks only enough of the wiki domains API to reach the Document view's
// "New Page" form with a domain pre-selected (wiki-focus-button.spec.ts's
// pattern) — no chat/graph mocking needed for this suite.
const DOMAIN = { id: 'mobile-zoom-test', domain: 'infrastructure', tags: [] };

async function mockWikiDomain(page: Page) {
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    await route.fulfill({ json: [DOMAIN] });
  });
  await page.route('**/api/v1/wiki/domains/*/pages', async (route: Route) => {
    await route.fulfill({ json: [] });
  });
}

test.describe(
  '@smoke',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('the "Move to" lane picker renders at a mobile-safe font-size', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-zoom-select');
      await createTask(request, { title: 'Mobile zoom select task', workspaceId: ws.id });

      await page.goto(`/workspaces/${ws.id}`);
      // At this (mobile) viewport the grouped mobile task list renders, not
      // the desktop five-lane board — "Tasks" is a link here, and opening a
      // card taps into the same TaskDrawer (and BoardCallout) as desktop.
      await page.getByRole('link', { name: /tasks/i }).click();
      await expect(page.getByTestId('task-list-mobile')).toBeVisible();
      await page.getByTestId('task-card').filter({ hasText: 'Mobile zoom select task' }).click();

      const select = page.locator('dialog[open]').getByTestId('board-move-to');
      await pauseBeforeAction(page, testInfo);
      await expect(select).toBeVisible();
      expect(await computedFontSizePx(select)).toBeGreaterThanOrEqual(16);
    });

    test('the Hand-Off Guidance textarea renders at a mobile-safe font-size', async ({
      page,
      request,
    }, testInfo) => {
      const task = await createTask(request, { title: 'Mobile zoom textarea task' });
      await request.patch(`/api/v1/tasks/${task.id}`, { data: { status: 'blocked' } });
      await mockHandedOffRun(page, task.id);

      await page.goto('/inbox');
      await page
        .getByTestId('inbox-task-row')
        .filter({ hasText: 'Mobile zoom textarea task' })
        .click();

      const textarea = page.getByTestId('hand-off-guidance-input');
      await pauseBeforeAction(page, testInfo);
      await expect(textarea).toBeVisible();
      expect(await computedFontSizePx(textarea)).toBeGreaterThanOrEqual(16);
    });

    test('the wiki "New Page" title input renders at a mobile-safe font-size', async ({
      page,
    }, testInfo) => {
      await mockWikiDomain(page);
      await page.goto('/wiki?view=document');

      await page.getByRole('button', { name: 'New page' }).click();
      const input = page.getByTestId('new-page-title-input');
      await pauseBeforeAction(page, testInfo);
      await expect(input).toBeVisible();
      expect(await computedFontSizePx(input)).toBeGreaterThanOrEqual(16);
    });
  },
);
