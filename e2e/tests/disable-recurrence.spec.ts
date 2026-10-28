import { test, expect, type Locator, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';

const suite: TestSuite = {
  id: 46,
  name: 'Disable Recurrence — board lane and drawer banner',
  description:
    'Verifies a cron_repeat task whose agent called disable_recurrence (#360) shows up in the Done lane, not Schedule Paused, and that the drawer banner explains why in its own words',
  purpose:
    'A self-disabled recurring task is a healthy outcome (the work finished), not a problem — landing it in the wrong lane or showing the generic "Schedule is off" message would make it indistinguishable from a broken schedule',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        "Load a workspace's Tasks board with a task whose schedule carries pausedReason: 'no_further_runs_needed'",
      expectedOutcome: "The card renders in the Done lane with status 'pending'",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open that card in the drawer',
      expectedOutcome:
        'The schedule banner reads "Finished — the agent determined no further runs are needed."',
      test: () => {},
    },
  ],
};

const MOCK_TASK_ID = 'disable-recurrence-task-1';

// disable_recurrence's effect (triggerConfig.pausedReason: 'no_further_runs_needed',
// board.lane: 'done', schedule.inactiveReason: 'completed') is produced by an
// agent mid-run, not through any user-facing endpoint — mocking the whole
// hydration response is the established way to reach it (see
// e2e/AGENTS.md's "Mock hydration, not the live turn", and
// task-board-dnd.spec.ts's cohort-holder test for the same technique).
async function mockDisabledRecurrenceTask(page: Page, workspaceId: string) {
  await page.route('**/api/v1/tasks?*', (route) =>
    route.fulfill({
      json: [
        {
          id: MOCK_TASK_ID,
          workspaceId,
          title: 'Refactor Scheduler.js',
          description: null,
          outcome: null,
          status: 'pending',
          assignedTo: 'agent',
          dueAt: null,
          expiresAt: null,
          triggerType: 'cron_repeat',
          triggerConfig: {
            expression: '0 0 * * *',
            timezone: 'UTC',
            enabled: false,
            maxIterations: null,
            stopAfter: null,
            maxConsecutiveFailures: 3,
            enabledAt: '2026-10-01T00:00:00.000Z',
            lastFiredAt: '2026-10-26T00:00:00.000Z',
            consecutiveFailures: 0,
            pausedReason: 'no_further_runs_needed',
          },
          trackerType: null,
          trackerId: null,
          plan: null,
          blockedReason: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          schedule: {
            nextFireAt: null,
            iterationCount: 39,
            active: false,
            inactiveReason: 'completed',
            lastRunOutcome: 'done',
          },
          board: {
            lane: 'done',
            moves: [{ to: 'backlog', needs: 'none' }],
          },
        },
      ],
    }),
  );
}

async function openTasksTab(page: Page, workspaceId: string) {
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole('button', { name: /tasks/i }).click();
  await expect(page.getByTestId('task-board')).toBeVisible();
}

const lane = (page: Page, id: string) => page.locator(`[data-column="${id}"]`);
const card = (scope: Page | Locator, title: string) =>
  scope.locator('[data-testid="task-card"]').filter({ hasText: title });

test.describe('@smoke', { annotation: suiteAnnotations(suite) }, () => {
  test('shows a self-disabled recurring task in Done, with the self-disabled banner in its drawer', async ({
    page,
    request,
  }) => {
    const wsRes = await request.post('/api/v1/workspaces', {
      data: {
        name: `disable-recurrence-${Date.now()}`,
        locationRoot: 'temporary',
        directoryName: `disable-recurrence-${Date.now()}`,
      },
    });
    expect(wsRes.status(), 'workspace created').toBe(201);
    const ws = (await wsRes.json()) as { id: string };

    await mockDisabledRecurrenceTask(page, ws.id);
    await openTasksTab(page, ws.id);

    const taskCard = card(lane(page, 'done'), 'Refactor Scheduler.js');
    await expect(taskCard).toBeVisible();
    await expect(taskCard).toHaveAttribute('data-status', 'pending');
    // 'attention' is the lane a consecutive-failures auto-pause (the
    // board-rules.ts 'schedule_paused' source) lands in — this task must not
    // be mistaken for that.
    await expect(card(lane(page, 'attention'), 'Refactor Scheduler.js')).not.toBeVisible();

    await taskCard.click();
    const drawer = page.locator('dialog[open]');
    await expect(drawer).toBeVisible();

    const banner = drawer.locator('[data-testid="schedule-inactive-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-reason', 'completed');
    await expect(banner).toHaveText('Finished — the agent determined no further runs are needed.');

    await request.delete(`/api/v1/workspaces/${ws.id}`);
  });
});
