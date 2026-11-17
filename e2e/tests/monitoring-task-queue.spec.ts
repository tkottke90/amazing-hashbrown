import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 60,
  name: 'Monitoring — Task Queue Monitor',
  description:
    "Verifies the /monitoring page's Task Queue Monitor table: every queued/running task app-wide, its Workspace/Pinned Provider/Status/Actions, and that Cancel actually mutates real state",
  purpose:
    'This panel exists so a stuck or queued task can be found and acted on without opening every workspace one at a time — regression-test that it shows the right rows and that its Actions column is wired to the real backend, not just a local optimistic update',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action:
        'Enqueue a task into an occupied workspace scope (stays ready, not dequeued) alongside the task already running there',
      expectedOutcome:
        'Both rows appear with the right Workspace/Status, and the Pinned Provider switch is enabled for the ready row, disabled for the running row',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Click Cancel on the ready row's Actions and confirm the prompt",
      expectedOutcome:
        "The row disappears from the table and the task's real status is 'cancelled'",
      test: () => {},
    },
  ],
};

async function createWorkspace(request: APIRequestContext, name: string) {
  const res = await request.post('/api/v1/workspaces', {
    data: { name, locationRoot: 'temporary', directoryName: name },
  });
  expect(res.status(), 'Expect the workspace to be created').toBe(201);
  return res.json();
}

async function createTask(
  request: APIRequestContext,
  title: string,
  workspaceId: string,
): Promise<{ id: string; status: string }> {
  const res = await request.post('/api/v1/tasks', {
    data: { title, workspaceId, assignedTo: 'agent' },
  });
  expect(res.status(), 'Expect the task to be created').toBe(201);
  return res.json();
}

async function enqueue(request: APIRequestContext, taskId: string) {
  const res = await request.post(`/api/v1/tasks/${taskId}/enqueue`);
  expect(res.status(), 'Expect the task to be enqueued').toBe(201);
}

function monitorRow(page: Page, taskId: string) {
  return page.locator(`[data-testid="monitoring-queue-row"][data-task-id="${taskId}"]`);
}

// Serial: the second test's "running" task is what keeps the third test's
// task 'ready' (not dequeued) — the scheduler serializes per workspace scope
// (issue #160), and the e2e API server's no-op task executor (see
// e2e/AGENTS.md) holds whatever it dequeues at 'running' forever, so the
// workspace's one running slot never frees up on its own.
test.describe.serial('@user-workflow', { annotation: suiteAnnotations(suite) }, () => {
  let workspaceId: string;
  let runningTaskId: string;
  let readyTaskId: string;

  // The running task is never cleaned up on its own (the no-op executor
  // can't be interrupted), so the workspace itself is deleted afterward:
  // that cascades to its tasks and queue rows, same pattern
  // task-board-dnd.spec.ts's afterEach uses, and for the same reason —
  // otherwise this task would stay globally visible for the rest of the
  // suite and could break a later spec (e.g. task-queue-widget.spec.ts)
  // that expects an empty queue at its own start.
  test.afterAll(async ({ request }) => {
    if (workspaceId) await request.delete(`/api/v1/workspaces/${workspaceId}`);
  });

  test('lists a running task and its blocked ready sibling, with correct gating', async ({
    page,
    request,
  }, testInfo) => {
    const ws = await createWorkspace(request, `monitoring-tq-ws-${Date.now()}`);
    workspaceId = ws.id;

    const running = await createTask(request, 'Monitoring: running task', ws.id);
    runningTaskId = running.id;
    await enqueue(request, runningTaskId);

    const ready = await createTask(request, 'Monitoring: ready task', ws.id);
    readyTaskId = ready.id;
    await enqueue(request, readyTaskId);

    await page.goto('/monitoring');
    await pauseBeforeAction(page, testInfo);

    const runningRow = monitorRow(page, runningTaskId);
    await expect(runningRow).toBeVisible();
    await expect(runningRow).toContainText('Monitoring: running task');
    await expect(runningRow).toContainText(ws.name);
    await expect(runningRow).toContainText('Running');
    await expect(runningRow.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(
      runningRow.getByTitle("Can't switch provider while running — pause or cancel instead."),
    ).toBeDisabled();

    const readyRow = monitorRow(page, readyTaskId);
    await expect(readyRow).toBeVisible();
    await expect(readyRow).toContainText('Monitoring: ready task');
    await expect(readyRow).toContainText(ws.name);
    await expect(readyRow).toContainText('Queued');
    await expect(readyRow.getByRole('button', { name: 'Pause' })).not.toBeVisible();
    await expect(
      readyRow.getByTitle('Switch provider — takes effect immediately.'),
    ).toBeEnabled();
  });

  test("cancelling the ready row's task via Actions removes it and really cancels it", async ({
    page,
    request,
  }, testInfo) => {
    await page.goto('/monitoring');
    const readyRow = monitorRow(page, readyTaskId);
    await expect(readyRow).toBeVisible();

    page.on('dialog', (d) => d.accept());
    await pauseBeforeAction(page, testInfo);
    await readyRow.getByRole('button', { name: 'Cancel' }).click();

    await expect(readyRow).not.toBeVisible();
    const fetched = await (await request.get(`/api/v1/tasks/${readyTaskId}`)).json();
    expect(fetched.status).toBe('cancelled');

    // The running task is untouched by cancelling its unrelated sibling.
    await expect(monitorRow(page, runningTaskId)).toBeVisible();
  });
});
