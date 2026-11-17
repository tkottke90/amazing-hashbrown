import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 61,
  name: 'Monitoring — Provider Activity Monitor',
  description:
    "Verifies the /monitoring page's Provider Activity Monitor (Room view): provider bars render for every configured provider, a ready task not yet dequeued shows on its Pinned Provider's Green Room lane, and dragging that chip onto a different provider's bar really re-pins it",
  purpose:
    'Providers have concurrency limits with no prior visibility into who is using one — regression-test that the Room view actually renders real provider/task state, and that its one interactive gesture (drag-to-re-pin) performs the real PATCH it claims to, not just a local visual move',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Navigate to /monitoring with no providers configured',
      expectedOutcome: 'The Provider Activity Monitor shows "No providers configured."',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'Configure two real providers, then enqueue a running task and a ready task (pinned to the first provider) into the same occupied workspace',
      expectedOutcome:
        "Both providers' bars render, and the ready task's chip appears, draggable, on the first provider's Green Room lane",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Drag the ready task's chip onto the second provider's bar",
      expectedOutcome: "The task's Pinned Provider is really switched to the second provider",
      test: () => {},
    },
  ],
};

const E2E_PROVIDER_1 = 'monitoring-e2e-provider-1';
const E2E_PROVIDER_2 = 'monitoring-e2e-provider-2';
// Only ever pinned alongside E2E_PROVIDER_1 below — patchTaskHandler requires
// provider/model to be set as a matched pair, but never validates the model
// string against a live model list (tasks.handlers.ts: "trusted from the
// client... falls back gracefully at run time if it's ever wrong").
const E2E_MODEL_1 = 'monitoring-e2e-model-1';

// PATCH /api/v1/tasks/:id validates a Pinned Provider change's provider name
// against the real, server-side env.providers (tasks.handlers.ts) — same
// reason task-model-pin.spec.ts registers a real provider rather than only
// mocking GET /api/v1/providers. Cleanup restores an empty list so this
// doesn't leak into other specs sharing the server.
async function seedProviders(request: APIRequestContext) {
  const res = await request.patch('/api/v1/settings/model-providers', {
    data: {
      providers: [
        { name: E2E_PROVIDER_1, type: 'ollama', baseUrl: 'http://localhost:11434' },
        { name: E2E_PROVIDER_2, type: 'ollama', baseUrl: 'http://localhost:11434' },
      ],
      defaultProvider: E2E_PROVIDER_1,
    },
  });
  expect(res.status()).toBe(200);
}

async function clearProviders(request: APIRequestContext) {
  await request.patch('/api/v1/settings/model-providers', {
    data: { providers: [], defaultProvider: '' },
  });
}

async function createWorkspace(request: APIRequestContext, name: string) {
  const res = await request.post('/api/v1/workspaces', {
    data: { name, locationRoot: 'temporary', directoryName: name },
  });
  expect(res.status()).toBe(201);
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
  expect(res.status()).toBe(201);
  return res.json();
}

async function enqueue(request: APIRequestContext, taskId: string) {
  const res = await request.post(`/api/v1/tasks/${taskId}/enqueue`);
  expect(res.status()).toBe(201);
}

function providerBar(page: Page, provider: string) {
  return page.locator(`[data-testid="provider-bar"][data-provider-bar="${provider}"]`);
}

function greenRoomLane(page: Page, provider: string) {
  return page.locator(`[data-testid="green-room-lane"][data-provider="${provider}"]`);
}

// A real pointer drag, same mechanics as task-board-dnd.spec.ts's drag()
// (this view's Green Room chips use native Pointer Events directly, not
// dnd-kit, but the browser dispatches pointerdown/pointermove/pointerup from
// a real mouse sequence either way).
async function dragOnto(page: Page, source: Locator, target: Locator) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.describe.serial('@user-workflow', { annotation: suiteAnnotations(suite) }, () => {
  test('shows "No providers configured." when none are set up', async ({
    page,
    request,
  }, testInfo) => {
    await clearProviders(request);
    await page.goto('/monitoring');
    await pauseBeforeAction(page, testInfo);
    await expect(page.getByText('No providers configured.')).toBeVisible();
  });

  test.describe.serial('two configured providers with a ready task pinned to the first', () => {
    let readyTaskId: string;
    // The occupying "running" task is never cleaned up on its own (the e2e
    // server's no-op executor can't be interrupted — see e2e/AGENTS.md), so
    // the workspace itself is deleted afterward instead: that cascades to
    // its tasks and queue rows, same pattern task-board-dnd.spec.ts's
    // afterEach uses, and for the same reason — otherwise this permanently
    // running task would stay globally visible for the rest of the suite
    // and break any later spec (e.g. task-queue-widget.spec.ts) that
    // expects an empty queue at its own start.
    let workspaceId: string;

    test.beforeAll(async ({ request }) => {
      await seedProviders(request);
    });

    test.afterAll(async ({ request }) => {
      await clearProviders(request);
      if (workspaceId) await request.delete(`/api/v1/workspaces/${workspaceId}`);
    });

    test('renders both provider bars and the ready task chip on its Pinned Provider lane', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, `monitoring-pa-ws-${Date.now()}`);
      workspaceId = ws.id;

      // Occupies the workspace's one running slot (no-op executor holds it
      // forever — see e2e/AGENTS.md), so the second task stays 'ready',
      // never dequeued — same pattern task-queue-widget.spec.ts's cancel/
      // take-over tests use.
      const running = await createTask(request, 'Provider activity: running task', ws.id);
      await enqueue(request, running.id);

      const ready = await createTask(request, 'Provider activity: ready task', ws.id);
      readyTaskId = ready.id;
      const patchRes = await request.patch(`/api/v1/tasks/${ready.id}`, {
        data: { provider: E2E_PROVIDER_1, model: E2E_MODEL_1 },
      });
      expect(patchRes.status()).toBe(200);
      await enqueue(request, readyTaskId);

      await page.goto('/monitoring');
      await pauseBeforeAction(page, testInfo);

      await expect(providerBar(page, E2E_PROVIDER_1)).toBeVisible();
      await expect(providerBar(page, E2E_PROVIDER_2)).toBeVisible();

      const chip = greenRoomLane(page, E2E_PROVIDER_1).getByTestId('green-room-chip-ready');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('Provider activity: ready task');
    });

    test('dragging the chip onto the second provider bar re-pins the task for real', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/monitoring');
      const chip = greenRoomLane(page, E2E_PROVIDER_1).getByTestId('green-room-chip-ready');
      await expect(chip).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await dragOnto(page, chip, providerBar(page, E2E_PROVIDER_2));

      // Chip moves to the second provider's own lane, locally and for real.
      const movedChip = greenRoomLane(page, E2E_PROVIDER_2).getByTestId('green-room-chip-ready');
      await expect(movedChip).toContainText('Provider activity: ready task');
      await expect(
        greenRoomLane(page, E2E_PROVIDER_1).getByTestId('green-room-chip-ready'),
      ).not.toBeVisible();

      const fetched = await (await request.get(`/api/v1/tasks/${readyTaskId}`)).json();
      expect(fetched.provider).toBe(E2E_PROVIDER_2);
    });
  });
});
