import { test, expect, type Route, type Page, type APIRequestContext } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 40,
  name: 'Task Runs — read-only run view',
  description:
    'Every automated task run has its own thread, opened read-only from the task drawer, from ' +
    'run markers and copied questions in the workspace chat, and answerable only through its ' +
    'own question card',
  purpose:
    'A recurring task accumulates many runs; each must be reviewable on its own, and a run that ' +
    'is waiting on the user must be answerable — Inbox task runs previously had no view at all',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: "Open an Inbox task's drawer and click a row in its Run history",
      expectedOutcome:
        'The run opens at /chat/:runThreadId as a read-only transcript: header names the run and ' +
        'task, there is no message box',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Answer a paused run's question from the run view",
      expectedOutcome: "The answer is posted to the run thread's /hitl route with its promptId",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click "Open run" on a workspace task\'s question copied into the workspace chat',
      expectedOutcome: 'The run that asked the question opens in the read-only run view',
      test: () => {},
    },
  ],
};

const RUN_THREAD = 'e2e-run-thread-1';

function runThreadBody(overrides: { workspaceId?: string | null; messages?: unknown[] } = {}) {
  return {
    id: RUN_THREAD,
    title: 'e2e-run-task — run #2',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:05:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    type: 'task',
    provider: null,
    model: null,
    taskRun: {
      taskId: 'e2e-task',
      taskTitle: 'e2e-run-task',
      workspaceId: overrides.workspaceId ?? null,
      runId: 'e2e-run-2',
      runNumber: 2,
      status: 'paused',
      triggerSource: 'manual',
    },
    messages: overrides.messages ?? [
      {
        id: 'a1',
        kind: 'assistant',
        seq: 1,
        status: 'done',
        content: 'Checked the dependency list.',
        sentAt: '2026-09-26T00:01:00.000Z',
      },
    ],
  };
}

// GET /api/v1/threads/:RUN_THREAD — the run view's hydrate().
async function mockRunThread(page: Page, body = runThreadBody()) {
  await page.route(`**/api/v1/threads/${RUN_THREAD}`, async (route: Route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: body });
  });
}

async function createWorkspace(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/api/v1/workspaces', {
    data: { name, locationRoot: 'temporary', directoryName: name },
  });
  expect(res.status(), 'Expect the workspace to be created').toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test("opens a run from an Inbox task's run history as a read-only transcript", async ({
      page,
      request,
    }, testInfo) => {
      const taskRes = await request.post('/api/v1/tasks', { data: { title: 'e2e-run-task' } });
      expect(taskRes.status()).toBe(201);
      const taskId = ((await taskRes.json()) as { id: string }).id;

      try {
        // The run history a task with two finished runs would return.
        await page.route(`**/api/v1/tasks/${taskId}/runs**`, async (route: Route) => {
          await route.fulfill({
            json: [
              {
                id: 'e2e-run-2',
                taskId,
                status: 'done',
                position: 2,
                enqueuedAt: '2026-09-26T00:00:00.000Z',
                startedAt: '2026-09-26T00:00:00.000Z',
                finishedAt: '2026-09-26T00:05:00.000Z',
                recoveryAttempts: 0,
                threadId: RUN_THREAD,
                summary: 'Audited 12 packages; no advisories.',
                triggerSource: 'manual',
                scheduledFor: null,
                runNumber: 2,
              },
            ],
          });
        });
        await mockRunThread(page);

        await page.goto('/inbox');
        const row = page
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-run-task' });
        await pauseBeforeAction(page, testInfo);
        await row.click();

        const historyRow = page.getByTestId('task-run-history-row');
        await expect(historyRow).toContainText('Run #2');
        await expect(historyRow).toContainText('Audited 12 packages; no advisories.');

        await pauseBeforeAction(page, testInfo);
        await historyRow.click();

        await expect(page).toHaveURL(new RegExp(`/chat/${RUN_THREAD}$`));
        await expect(page.getByTestId('task-run-view')).toBeVisible();
        await expect(page.getByTestId('task-run-title')).toContainText('Run #2 of e2e-run-task');
        await expect(page.getByText('Checked the dependency list.')).toBeVisible();
        await expect(page.getByTestId('task-run-readonly-note')).toBeVisible();
        await expect(page.locator('[data-slot="textarea"]')).toHaveCount(0);
      } finally {
        await request.delete(`/api/v1/tasks/${taskId}`);
      }
    });

    test("answers a paused run's question from the run view", async ({ page }, testInfo) => {
      await mockRunThread(
        page,
        runThreadBody({
          messages: [
            {
              id: 'p1',
              kind: 'hitl_prompt',
              seq: 1,
              status: 'pending',
              promptId: 'p1',
              question: 'Which registry should I audit?',
              promptKind: 'free_text',
              taskId: 'e2e-task',
            },
          ],
        }),
      );
      let posted: unknown = null;
      await page.route(`**/api/v1/chat/${RUN_THREAD}/hitl`, async (route: Route) => {
        posted = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: 'data: {"type":"stream_done","durationMs":0}\n\n',
        });
      });

      await page.goto(`/chat/${RUN_THREAD}`);
      await expect(page.getByText('Which registry should I audit?')).toBeVisible();

      await page.getByPlaceholder('Type your answer…').fill('npm');
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Submit' }).click();

      await expect.poll(() => posted).toEqual({ promptId: 'p1', answer: 'npm' });
    });

    test('opens the run behind a question copied into the workspace chat', async ({
      page,
      request,
    }, testInfo) => {
      const wsId = await createWorkspace(request, 'e2e-task-runs-ws');

      try {
        // The workspace chat's hydrate(): a workspace task run's question,
        // copied here by the API with a link back to its run thread.
        await page.route(`**/api/v1/workspaces/${wsId}/chat/**`, async (route: Route) => {
          if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
          }
          await route.fulfill({
            json: {
              messages: [
                {
                  id: 'copy-1',
                  kind: 'hitl_prompt',
                  seq: 1,
                  status: 'pending',
                  promptId: 'copy-1',
                  question: 'Deploy the audited lockfile?',
                  promptKind: 'yes_no',
                  taskId: 'e2e-task',
                  runThreadId: RUN_THREAD,
                },
              ],
              summaryPath: null,
              summarizedAt: null,
            },
          });
        });
        await mockRunThread(page, runThreadBody({ workspaceId: wsId }));

        await page.goto(`/workspaces/${wsId}`);
        await page.getByRole('button', { name: 'Chat' }).click();
        await expect(page.getByText('Deploy the audited lockfile?')).toBeVisible();

        await pauseBeforeAction(page, testInfo);
        await page.getByTestId('hitl-open-run').click();

        await expect(page).toHaveURL(new RegExp(`/chat/${RUN_THREAD}$`));
        await expect(page.getByTestId('task-run-title')).toContainText('Run #2 of e2e-run-task');

        await pauseBeforeAction(page, testInfo);
        await page.getByTestId('task-run-back').click();
        await expect(page).toHaveURL(new RegExp(`/workspaces/${wsId}$`));
      } finally {
        await request.delete(`/api/v1/workspaces/${wsId}`);
      }
    });
  },
);
