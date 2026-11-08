import { test, expect, type Route, type Page, type APIRequestContext } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 41,
  name: 'Hand-Off Guidance — resolving a handed-off task from the drawer',
  description:
    'A task whose latest run settled handed_off (either Hand-Off Cause) shows its Hand-Off ' +
    'Note and a Hand-Off Guidance field in the Task Drawer; saving guidance folds it into a ' +
    "rewritten title/description via the server's one-shot LLM call, without re-enqueueing " +
    'the task or closing the drawer',
  purpose:
    'ADR-0056/ADR-0057: a repeated-budget-failure hand-off needs a human-facing way to narrow ' +
    'scope before retrying, and the drawer previously gave no indication a task had been ' +
    'handed off at all, let alone a way to respond to it',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: "Open a handed-off task's drawer",
      expectedOutcome:
        'The drawer shows a labeled "Why this got stuck" note and a Hand-Off Guidance field, ' +
        'instead of the generic Paused task controls panel',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Type guidance and click Save guidance',
      expectedOutcome:
        'The title/description fields update in place with the rewritten text; the drawer ' +
        'stays open and the task is not re-enqueued',
      test: () => {},
    },
  ],
};

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/v1/tasks', { data: { title } });
  expect(res.status(), 'Expect the task to be created').toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const patchRes = await request.patch(`/api/v1/tasks/${id}`, { data: { status: 'blocked' } });
  expect(patchRes.status(), 'Expect the task to move to blocked').toBe(200);
  return id;
}

async function mockHandedOffRun(
  page: Page,
  taskId: string,
  summary: string,
  handoffReason: 'exhaustion_cap' | 'agent_requested' | 'awaiting_user_action' = 'exhaustion_cap',
) {
  await page.route(`**/api/v1/tasks/${taskId}/runs**`, async (route: Route) => {
    await route.fulfill({
      json: [
        {
          id: 'e2e-run-1',
          taskId,
          status: 'handed_off',
          position: 1,
          enqueuedAt: '2026-11-05T00:00:00.000Z',
          startedAt: '2026-11-05T00:00:00.000Z',
          finishedAt: '2026-11-05T00:05:00.000Z',
          recoveryAttempts: 0,
          threadId: 'e2e-run-thread-1',
          summary,
          triggerSource: 'manual',
          scheduledFor: null,
          handoffReason,
          runNumber: 1,
        },
      ],
    });
  });
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('shows the Hand-Off Note and Hand-Off Guidance field for a handed-off task', async ({
      page,
      request,
    }, testInfo) => {
      const taskId = await createTask(request, 'e2e-hand-off-task');

      try {
        await mockHandedOffRun(page, taskId, 'Ran out of steps twice with unchanged scope.');

        await page.goto('/inbox');
        const row = page
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-hand-off-task' });
        await pauseBeforeAction(page, testInfo);
        await row.click();

        const block = page.getByTestId('hand-off-guidance');
        await expect(block).toBeVisible();
        await expect(block).toContainText('Ran out of steps twice with unchanged scope.');
        await expect(page.getByTestId('hand-off-guidance-input')).toBeVisible();
      } finally {
        await request.delete(`/api/v1/tasks/${taskId}`);
      }
    });

    test('labels an Externally-Blocked Hand-Off distinctly (issue #367, ADR-0059)', async ({
      page,
      request,
    }, testInfo) => {
      const taskId = await createTask(request, 'e2e-externally-blocked-task');

      try {
        await mockHandedOffRun(
          page,
          taskId,
          'Complete the OAuth consent flow and drop credentials.json in config/.',
          'awaiting_user_action',
        );

        await page.goto('/inbox');
        const row = page
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-externally-blocked-task' });
        await pauseBeforeAction(page, testInfo);
        await row.click();

        const block = page.getByTestId('hand-off-guidance');
        await expect(block).toBeVisible();
        await expect(block).toContainText('Externally blocked');
        await expect(block).toContainText(
          'Complete the OAuth consent flow and drop credentials.json in config/.',
        );
      } finally {
        await request.delete(`/api/v1/tasks/${taskId}`);
      }
    });

    test('saves guidance, rewrites the title/description, and keeps the drawer open', async ({
      page,
      request,
    }, testInfo) => {
      const taskId = await createTask(request, 'e2e-hand-off-rewrite-task');

      try {
        await mockHandedOffRun(page, taskId, 'Ran out of steps twice with unchanged scope.');

        let postedGuidance: unknown = null;
        await page.route(`**/api/v1/tasks/${taskId}/hand-off-guidance`, async (route: Route) => {
          postedGuidance = route.request().postDataJSON();
          await route.fulfill({
            json: {
              id: taskId,
              workspaceId: null,
              title: 'e2e-hand-off-rewrite-task (narrowed to the login spec)',
              description: 'Focus only on the login spec',
              outcome: null,
              status: 'blocked',
              assignedTo: null,
              dueAt: null,
              expiresAt: null,
              triggerType: 'manual',
              triggerConfig: null,
              trackerType: null,
              trackerId: null,
              plan: null,
              blockedReason: null,
              provider: null,
              model: null,
              archivedAt: null,
              createdAt: '2026-11-05T00:00:00.000Z',
              updatedAt: '2026-11-05T00:10:00.000Z',
              board: { lane: 'attention', moves: [] },
            },
          });
        });

        await page.goto('/inbox');
        const row = page
          .locator('[data-testid="inbox-task-row"]')
          .filter({ hasText: 'e2e-hand-off-rewrite-task' });
        await row.click();
        // Scoped to the one open drawer — the page can carry other (hidden)
        // dialog instances that also match a bare placeholder lookup.
        const dialog = page.getByRole('dialog').filter({ hasText: 'Hand-Off Guidance' });
        await expect(dialog.getByTestId('hand-off-guidance')).toBeVisible();

        await dialog
          .getByTestId('hand-off-guidance-input')
          .fill('Narrow it to just the login spec');
        await pauseBeforeAction(page, testInfo);
        await dialog.getByRole('button', { name: 'Save guidance' }).click();

        await expect
          .poll(() => postedGuidance)
          .toEqual({ guidance: 'Narrow it to just the login spec' });
        await expect(dialog.getByPlaceholder('Task title')).toHaveValue(
          'e2e-hand-off-rewrite-task (narrowed to the login spec)',
        );
        await expect(dialog.getByPlaceholder('What needs to be done?')).toHaveValue(
          'Focus only on the login spec',
        );
        // Still open — a successful rewrite never closes the drawer (ADR-0057),
        // and it never re-enqueues: the field is unchanged from the mocked response.
        await expect(dialog.getByTestId('hand-off-guidance-input')).toBeVisible();
      } finally {
        await request.delete(`/api/v1/tasks/${taskId}`);
      }
    });
  },
);
