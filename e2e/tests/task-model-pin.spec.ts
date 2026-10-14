import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 52,
  name: 'Task model pin',
  description:
    'Lets a user pin a task to a specific provider/model from the Task Details drawer while the task is idle, and blocks changing it while the task is running',
  purpose:
    'A task stuck on a struggling or unaffordable default model previously had no escape short of changing the system-wide default for every task — this guards the full loop: picker selection, Save, and persistence after reopening, plus the running-task guard',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: "Open an idle task's drawer, pick a provider/model from the Model field, and Save",
      expectedOutcome: 'The Model field shows the selected pair after Save',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Close and reopen the drawer',
      expectedOutcome: 'The selected provider/model persisted',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Open a running task's drawer",
      expectedOutcome: 'The Model field is disabled',
      test: () => {},
    },
  ],
};

// A dedicated provider name, distinct from any other suite's, since this is
// registered against the real, shared server config (see seedProvider below)
// rather than only mocked in the browser.
const E2E_PROVIDER = 'task-model-pin-e2e-provider';
const E2E_MODEL = 'task-model-pin-e2e-model';

// PATCH /api/v1/tasks/:id validates a model-pin change's provider name
// against the real, server-side env.providers (see tasks.handlers.ts) — a
// browser-only mock of GET /api/v1/providers isn't enough to get a real Save
// past that guard. This registers a real provider against the actual running
// dev server, the same way these specs already create real
// workspaces/tasks via the API as setup state. Cleanup restores an empty
// providers list so this doesn't leak into other specs sharing the server.
async function seedProvider(request: APIRequestContext) {
  const res = await request.patch('/api/v1/settings/model-providers', {
    data: {
      providers: [{ name: E2E_PROVIDER, type: 'ollama', baseUrl: 'http://localhost:11434' }],
      defaultProvider: E2E_PROVIDER,
    },
  });
  expect(res.status()).toBe(200);
}

async function clearProvider(request: APIRequestContext) {
  await request.patch('/api/v1/settings/model-providers', {
    data: { providers: [], defaultProvider: '' },
  });
}

// GET /api/v1/providers also live-fetches each provider's actual model list
// (unreachable here — no real Ollama server) — mocked so the picker has
// something to select regardless, under the same provider name just
// registered for real above.
async function mockProviderModelList(page: Page) {
  await page.route('**/api/v1/providers', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        providers: [{ name: E2E_PROVIDER, type: 'ollama', models: [{ id: E2E_MODEL }] }],
        defaultProvider: E2E_PROVIDER,
        favoriteModels: [],
      },
    });
  });
}

function taskCard(page: Page, taskId: string) {
  return page.locator(`[data-testid="task-card"][data-task-id="${taskId}"]`);
}

// Serial: both tests seed/clear the same real, shared server-side provider
// config — running them concurrently in separate workers would race.
test.describe.serial('@user-workflow', { annotation: suiteAnnotations(suite) }, () => {
  test('selecting a model persists after Save and reopening the drawer', async ({
    page,
    request,
  }, testInfo) => {
    const wsName = `task-model-pin-ws-${Date.now()}`;
    const wsRes = await request.post('/api/v1/workspaces', {
      data: { name: wsName, locationRoot: 'temporary', directoryName: wsName },
    });
    expect(wsRes.status()).toBe(201);
    const ws = await wsRes.json();

    const taskRes = await request.post('/api/v1/tasks', {
      data: { title: 'Model pin test task', workspaceId: ws.id },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();

    await seedProvider(request);
    try {
      await mockProviderModelList(page);
      await page.goto(`/workspaces/${ws.id}`);
      await page.getByRole('button', { name: /tasks/i }).click();

      await pauseBeforeAction(page, testInfo);
      await taskCard(page, task.id).click();
      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      const modelTrigger = drawer.getByTestId('task-model-trigger');
      await expect(modelTrigger).toBeEnabled();

      await pauseBeforeAction(page, testInfo);
      await modelTrigger.click();
      await page.getByRole('menuitem', { name: E2E_PROVIDER, exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: E2E_MODEL, exact: true }).click();
      await expect(modelTrigger).toHaveText(`${E2E_PROVIDER} / ${E2E_MODEL}`);

      await drawer.getByRole('button', { name: 'Save changes' }).click();
      await expect(drawer).not.toBeVisible();

      // Reopen and confirm the selection persisted server-side, not just in
      // the form's own local state.
      await pauseBeforeAction(page, testInfo);
      await taskCard(page, task.id).click();
      const reopened = page.locator('dialog[open]');
      await expect(reopened).toBeVisible();
      await expect(reopened.getByTestId('task-model-trigger')).toHaveText(
        `${E2E_PROVIDER} / ${E2E_MODEL}`,
      );
    } finally {
      await clearProvider(request);
    }
  });

  test("a running task's Model field is disabled", async ({ page, request }, testInfo) => {
    const wsName = `task-model-pin-running-ws-${Date.now()}`;
    const wsRes = await request.post('/api/v1/workspaces', {
      data: { name: wsName, locationRoot: 'temporary', directoryName: wsName },
    });
    expect(wsRes.status()).toBe(201);
    const ws = await wsRes.json();

    // assignedTo: 'agent' + enqueue puts the task in the real queue; the
    // no-op task executor Playwright's own API server runs under (see
    // e2e/AGENTS.md) dequeues it and then never resolves, leaving it at
    // 'running' for the life of this test — no real LLM involved.
    const taskRes = await request.post('/api/v1/tasks', {
      data: { title: 'Running model pin test task', workspaceId: ws.id, assignedTo: 'agent' },
    });
    expect(taskRes.status()).toBe(201);
    const task = await taskRes.json();
    const enqRes = await request.post(`/api/v1/tasks/${task.id}/enqueue`);
    expect(enqRes.status()).toBe(201);

    await mockProviderModelList(page);
    await page.goto(`/workspaces/${ws.id}`);
    await page.getByRole('button', { name: /tasks/i }).click();

    await expect(taskCard(page, task.id)).toHaveAttribute('data-status', 'running');

    await pauseBeforeAction(page, testInfo);
    await taskCard(page, task.id).click();
    const drawer = page.locator('dialog[open]');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('task-model-trigger')).toBeDisabled();
  });
});
