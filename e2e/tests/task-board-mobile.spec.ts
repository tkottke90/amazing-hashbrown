import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 46,
  name: 'Tasks tab on a phone',
  description:
    'Verifies the mobile Tasks list: sections ordered by urgency, collapsible and remembered, one-tap card actions, the reply sheet, and quick add',
  purpose:
    "On a phone there's no drag-and-drop — every status change has to be an explicit, reachable tap, or mobile users can't manage their tasks at all",
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Open the Tasks tab at phone width',
      expectedOutcome: 'Sections render in urgency order and Finished starts collapsed',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Tap Retry on a failed task',
      expectedOutcome: 'The task is queued again and leaves Needs you',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Tap Run now on a scheduled task',
      expectedOutcome: 'The task is queued now; its repeating schedule is kept',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Tap Reply on a task waiting on you, tap a quick reply',
      expectedOutcome: 'The answer is sent as a move to the Queue',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Expand Finished, then reload',
      expectedOutcome: 'Finished stays expanded — collapse state is remembered',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Quick add a task with "Add to queue now" on',
      expectedOutcome: 'The task is created and queued for the agent',
      test: () => {},
    },
  ],
};

test.use({ viewport: { width: 390, height: 844 } });

async function createWorkspace(request: APIRequestContext, name: string) {
  const slug = `${name}-${Date.now()}`;
  const res = await request.post('/api/v1/workspaces', {
    data: { name: slug, locationRoot: 'temporary', directoryName: slug },
  });
  expect(res.status(), 'workspace created').toBe(201);
  return (await res.json()) as { id: string };
}

async function createTask(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post('/api/v1/tasks', { data });
  expect(res.status(), 'task created').toBe(201);
  return (await res.json()) as { id: string; status: string };
}

async function getTask(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/v1/tasks/${id}`)).json()) as {
    status: string;
    triggerType: string;
  };
}

async function openTasksTab(page: Page, workspaceId: string) {
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole('button', { name: /tasks/i }).click();
  await expect(page.getByTestId('task-list-mobile')).toBeVisible();
}

const section = (page: Page, id: string) => page.locator(`[data-section="${id}"]`);

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('sections are ordered by urgency and Finished starts collapsed', async ({
      page,
      request,
    }) => {
      const ws = await createWorkspace(request, 'mobile-sections');
      const failed = await createTask(request, { title: 'Failed job', workspaceId: ws.id });
      await request.patch(`/api/v1/tasks/${failed.id}`, { data: { status: 'failed' } });
      await createTask(request, { title: 'Backlog job', workspaceId: ws.id });
      const done = await createTask(request, { title: 'Done job', workspaceId: ws.id });
      await request.patch(`/api/v1/tasks/${done.id}`, { data: { status: 'done' } });

      await openTasksTab(page, ws.id);

      await expect(page.locator('[data-section]')).toHaveCount(3);
      const order = await page
        .locator('[data-section]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-section')));
      expect(order).toEqual(['needs_you', 'up_next', 'finished']);
      await expect(section(page, 'finished').getByTestId('task-card')).toHaveCount(0);
      // No drag-and-drop board on a phone.
      await expect(page.getByTestId('task-board')).toHaveCount(0);
    });

    test('Retry re-queues a failed task in one tap', async ({ page, request }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-retry');
      const task = await createTask(request, {
        title: 'Generate TLS cert',
        workspaceId: ws.id,
        assignedTo: 'agent',
      });
      await request.patch(`/api/v1/tasks/${task.id}`, { data: { status: 'failed' } });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await section(page, 'needs_you').getByTestId('card-action-retry').click();

      await expect
        .poll(async () => (await getTask(request, task.id)).status)
        .toMatch(/^(ready|running)$/);
      await expect(section(page, 'needs_you')).toHaveCount(0);
    });

    test('Run now queues a scheduled task and keeps its schedule', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-run-now');
      const task = await createTask(request, {
        title: 'Rotate credentials',
        workspaceId: ws.id,
        triggerType: 'cron_repeat',
        triggerConfig: { expression: '0 2 * * 3', timezone: 'UTC' },
      });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await section(page, 'scheduled').getByTestId('card-action-run-now').click();

      await expect
        .poll(async () => (await getTask(request, task.id)).status)
        .toMatch(/^(ready|running)$/);
      expect((await getTask(request, task.id)).triggerType).toBe('cron_repeat');
    });

    test('Reply answers the agent from the reply sheet', async ({ page, request }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-reply');
      const task = await createTask(request, {
        title: 'Choose backup target',
        workspaceId: ws.id,
        assignedTo: 'agent',
      });

      // A task only waits on the user after a live agent run asks a
      // question, which the e2e server (no LLM) can't produce. Hydrate that
      // state by overlaying it on the real task list; the answer's move is
      // mocked too, because without a real paused run there is no prompt
      // for the server to resolve. The move itself is covered by the API's
      // tasks-board.handlers tests.
      const waitingBoard = {
        lane: 'attention',
        moves: [{ to: 'queue', needs: 'reply' }],
        reason: {
          kind: 'waiting_on_user',
          question: 'Should nightly dumps go to the NAS or MinIO?',
          choices: [
            { label: 'NAS', value: 'NAS' },
            { label: 'MinIO', value: 'MinIO' },
          ],
          allowFreeText: true,
        },
      };
      let moveBody: unknown = null;
      await page.route('**/api/v1/tasks**', async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'GET' && url.pathname === '/api/v1/tasks') {
          const response = await route.fetch();
          const tasks = (await response.json()) as Array<Record<string, unknown>>;
          const patched = tasks.map((t) =>
            t['id'] === task.id ? { ...t, status: 'waiting_on_user', board: waitingBoard } : t,
          );
          return route.fulfill({ response, json: patched });
        }
        if (route.request().method() === 'POST' && url.pathname.endsWith(`/${task.id}/move`)) {
          moveBody = route.request().postDataJSON();
          const current = await (await request.get(`/api/v1/tasks/${task.id}`)).json();
          return route.fulfill({
            json: { ...current, status: 'ready', board: { lane: 'queue', moves: [] } },
          });
        }
        return route.fallback();
      });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await section(page, 'needs_you').getByTestId('card-action-reply').click();
      await expect(page.getByTestId('board-reply-question')).toContainText('NAS or MinIO');
      await pauseBeforeAction(page, testInfo);
      await page.getByTestId('board-reply-form').getByRole('button', { name: 'MinIO' }).click();

      await expect.poll(() => moveBody).toEqual({ to: 'queue', reply: 'MinIO' });
      await expect(page.getByRole('alert').filter({ hasText: 'Answered' })).toBeVisible();
    });

    test('collapse state is remembered across reloads', async ({ page, request }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-collapse');
      const done = await createTask(request, { title: 'Audit repo', workspaceId: ws.id });
      await request.patch(`/api/v1/tasks/${done.id}`, { data: { status: 'done' } });
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await section(page, 'finished').getByTestId('section-toggle').click();
      await expect(section(page, 'finished').getByTestId('task-card')).toHaveCount(1);

      await page.reload();
      await page.getByRole('button', { name: /tasks/i }).click();

      await expect(section(page, 'finished').getByTestId('task-card')).toHaveCount(1);
    });

    test('quick add creates a task and queues it for the agent', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-quick-add');
      await openTasksTab(page, ws.id);

      await pauseBeforeAction(page, testInfo);
      await page.getByTestId('quick-add-button').click();
      await page.getByLabel('Task title').fill('Renew certificates');
      await pauseBeforeAction(page, testInfo);
      await page.getByTestId('quick-add-form').getByRole('button', { name: 'Add' }).click();

      await expect
        .poll(async () => {
          const tasks = (await (
            await request.get(`/api/v1/tasks?workspace_id=${ws.id}`)
          ).json()) as Array<{ title: string; status: string }>;
          return tasks.find((t) => t.title === 'Renew certificates')?.status;
        })
        .toMatch(/^(ready|running)$/);
      await expect(
        page.getByTestId('task-card').filter({ hasText: 'Renew certificates' }),
      ).toBeVisible();
    });
  },
);
