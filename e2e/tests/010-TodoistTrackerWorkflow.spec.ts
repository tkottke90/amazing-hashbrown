import { expect, type Page, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import { CreatedWorkspace, createWorkspace, deleteWorkspace } from './workspace/utilities.js';
import { removeWorkspaceDir } from '../lib/workspace-files.js';

// Exercises the Todoist tracker adapter's UI flows (issue #82) without a
// real Todoist account: every /api/v1/trackers/todoist/** call, the tracker
// list and the Todoist verify call are mocked with page.route(). Settings,
// workspaces and tasks stay real, so the tracker link really persists on the
// task. Step 1 saves a token for real and then removes it again, so the API
// server's own Todoist adapter stays unconfigured and never calls Todoist
// (the Assignee Label service skips unconfigured adapters).

const TOKEN = 'e2e-fake-todoist-token';

const TODOIST_TRACKER = {
  type: 'todoist',
  displayName: 'Todoist',
  icon: '<svg viewBox="0 0 16 16"></svg>',
  canCreate: true,
  configured: true,
  authSchema: [
    { key: 'token', label: 'API token', type: 'password', required: true, supportsEnvRef: true },
  ],
};

const LINKED_ITEM = {
  id: 'td1Existing',
  url: 'https://app.todoist.com/app/task/td1Existing',
  title: 'Renew passport',
  state: 'pending',
  trackerState: 'active',
  dueAt: '2026-12-15',
};

const CREATED_ITEM = {
  id: 'td2Created',
  url: 'https://app.todoist.com/app/task/td2Created',
  title: 'E2E created Todoist task',
  state: 'pending',
  trackerState: 'active',
  dueAt: null,
};

interface TodoistMockOptions {
  configured?: boolean;
  containers?: 'ok' | 'fail';
}

// Records the body of each create request so a step can assert on it.
const createRequests: Array<Record<string, unknown>> = [];

async function mockTodoist(page: Page, opts: TodoistMockOptions = {}): Promise<void> {
  const configured = opts.configured ?? true;
  await page.route('**/api/v1/trackers**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;

    if (path === '/api/v1/trackers' && method === 'GET') {
      // Pass the real list through (keeps GitHub as the server reports it),
      // swapping in the mocked Todoist entry.
      const res = await route.fetch();
      const real = ((await res.json()) as Array<{ type: string }>).filter(
        (t) => t.type !== 'todoist',
      );
      await route.fulfill({
        json: [...real, { ...TODOIST_TRACKER, configured, canCreate: configured }],
      });
      return;
    }
    if (path === '/api/v1/trackers/todoist/verify') {
      await route.fulfill({ json: { valid: true } });
      return;
    }
    if (path === '/api/v1/trackers/todoist/resolve') {
      await route.fulfill({ json: LINKED_ITEM });
      return;
    }
    if (path === '/api/v1/trackers/todoist/items' && method === 'GET') {
      const id = url.searchParams.get('id');
      await route.fulfill({ json: id === CREATED_ITEM.id ? CREATED_ITEM : LINKED_ITEM });
      return;
    }
    if (path === '/api/v1/trackers/todoist/items' && method === 'POST') {
      createRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 201, json: CREATED_ITEM });
      return;
    }
    if (path === '/api/v1/trackers/todoist/containers') {
      if (opts.containers === 'fail') {
        await route.fulfill({ status: 500, json: { error: 'Todoist API error 503' } });
      } else {
        await route.fulfill({
          json: [
            { id: 'projWork', name: 'Work' },
            { id: 'projHome', name: 'Home' },
          ],
        });
      }
      return;
    }
    await route.fallback();
  });
}

let workspace: CreatedWorkspace | undefined;
const createdLocations: string[] = [];

async function openWorkspaceTasks(page: Page): Promise<void> {
  await page.goto(`/workspaces/${workspace!.id}`);
  await page.getByRole('button', { name: /tasks/i }).click();
}

async function openNewTaskDrawer(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add task' }).click();
  const drawer = page.locator('dialog[open]');
  await expect(drawer).toBeVisible();
  await drawer.locator('input[placeholder="Task title"]').fill(title);
  return drawer;
}

function taskCard(page: Page, title: string) {
  return page
    .locator('[data-column="backlog"]')
    .locator('[data-testid="task-card"]')
    .filter({ hasText: title });
}

export const TodoistTrackerWorkflow: TestSuite = {
  id: 10,
  name: 'Todoist Tracker Workflow',
  purpose:
    'Verify a user can configure Todoist, link a hashbrown task to an existing Todoist task (seeing its due date), and create a Todoist task in a chosen project from the task drawer — and that Todoist is only offered for linking once it is configured.',
  tag: [TAGS.UserWorkflow],
  recordVideo: true,
  beforeAll: async ({ request }) => {
    workspace = await createWorkspace(
      request,
      {
        name: `todoist-e2e-${Date.now()}`,
        locationRoot: 'temporary',
        directoryName: `todoist-e2e-${Date.now()}`,
      },
      createdLocations,
    );
  },
  afterAll: async ({ request }) => {
    // Belt and braces: never leave a Todoist token configured on the server.
    await request.patch('/api/v1/settings/trackers', { data: { todoist: { token: '' } } });
    // Deleting the workspace also deletes every task created in it.
    if (workspace?.id) await deleteWorkspace(request, workspace.id);
    for (const location of createdLocations) await removeWorkspaceDir(location);
  },
  steps: [
    {
      action: 'Configure and verify a Todoist API token in Settings, then remove it again',
      expectedOutcome:
        'Todoist is listed (as Not configured) before a token exists, the token verifies as Connected and persists across a reload, and can be removed',
      tag: [TAGS.Smoke],
      test: async ({ page }, testInfo) => {
        await mockTodoist(page, { configured: false });
        await page.goto('/settings?section=workspaces');
        const row = page.locator('[data-slot="tracker-row"]', { hasText: 'Todoist' });
        await expect(row).toBeVisible();
        await expect(row.getByText('Not configured')).toBeVisible();

        await pauseForVideo(page, TodoistTrackerWorkflow, testInfo);
        await row.getByRole('button', { name: 'Configure' }).click();
        const dialog = page.locator('dialog[open]');
        await dialog.getByLabel('API token', { exact: true }).fill(TOKEN);
        await dialog.getByRole('button', { name: 'Verify' }).click();
        await expect(dialog.getByText('Connected', { exact: true })).toBeVisible();

        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();

        await page.reload();
        await row.getByRole('button', { name: 'Configure' }).click();
        await expect(page.locator('dialog[open]').getByText('Currently set')).toBeVisible();

        await pauseForVideo(page, TodoistTrackerWorkflow, testInfo);
        await page.locator('dialog[open]').getByRole('button', { name: 'Remove' }).click();
        await page
          .locator('dialog[open]')
          .getByRole('button', { name: 'Save', exact: true })
          .click();
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();
      },
    },
    {
      action: 'Open a new task drawer while Todoist is not configured',
      expectedOutcome: 'Todoist is not offered in the tracker select',
      test: async ({ page }) => {
        await mockTodoist(page, { configured: false });
        await openWorkspaceTasks(page);
        const drawer = await openNewTaskDrawer(page, 'unused');
        const select = drawer.getByTestId('task-tracker-type-select');
        await expect(select.locator('option', { hasText: 'Not linked' })).toHaveCount(1);
        await expect(select.locator('option', { hasText: 'Todoist' })).toHaveCount(0);
        await drawer.getByRole('button', { name: 'Cancel' }).click();
      },
    },
    {
      action: 'Link a new task to an existing Todoist task by pasting its URL',
      expectedOutcome:
        'The preview shows the Todoist task with its due date, and the link survives saving and reopening the task',
      test: async ({ page }, testInfo) => {
        await mockTodoist(page);
        await openWorkspaceTasks(page);
        const title = `E2E Todoist link ${Date.now()}`;
        const drawer = await openNewTaskDrawer(page, title);
        await drawer.getByTestId('task-tracker-type-select').selectOption('todoist');

        await pauseForVideo(page, TodoistTrackerWorkflow, testInfo);
        await drawer
          .locator('input[placeholder="Paste a tracker URL to link it"]')
          .fill(LINKED_ITEM.url);
        const preview = drawer.getByTestId('task-tracker-preview');
        await expect(preview).toContainText(LINKED_ITEM.title);
        await expect(drawer.getByTestId('task-tracker-preview-due')).toContainText('2026-12-15');

        await drawer.getByRole('button', { name: 'Create task' }).click();
        await expect(taskCard(page, title)).toBeVisible();

        await pauseForVideo(page, TodoistTrackerWorkflow, testInfo);
        await taskCard(page, title).click();
        const reopened = page.locator('dialog[open]').getByTestId('task-tracker-preview');
        await expect(reopened.locator('a')).toHaveAttribute('href', LINKED_ITEM.url);
        await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
      },
    },
    {
      action: 'Create a new Todoist task in a chosen project from the task drawer',
      expectedOutcome:
        'The project select lists the Todoist projects with Inbox as default, the create request carries the chosen project, and the new item is linked',
      test: async ({ page }, testInfo) => {
        createRequests.length = 0;
        await mockTodoist(page);
        await openWorkspaceTasks(page);
        const title = `E2E Todoist create ${Date.now()}`;
        const drawer = await openNewTaskDrawer(page, title);
        await drawer.getByTestId('task-tracker-type-select').selectOption('todoist');
        await drawer.getByRole('button', { name: 'Create new Todoist item' }).click();

        const projects = drawer.getByTestId('task-tracker-container-select');
        await expect(projects.locator('option', { hasText: 'Work' })).toHaveCount(1);
        await expect(projects).toHaveValue('');

        await pauseForVideo(page, TodoistTrackerWorkflow, testInfo);
        await projects.selectOption({ label: 'Work' });
        await drawer.getByRole('button', { name: 'Create', exact: true }).click();

        await expect(drawer.getByTestId('task-tracker-preview')).toContainText(CREATED_ITEM.title);
        expect(createRequests).toHaveLength(1);
        expect(createRequests[0]).toMatchObject({ title, container: 'projWork' });

        await drawer.getByRole('button', { name: 'Create task' }).click();
        await expect(taskCard(page, title)).toBeVisible();
      },
    },
    {
      action: 'Create a Todoist task while the project list fails to load',
      expectedOutcome:
        'An inline error says the item will go to Inbox, and the task can still be created and linked',
      test: async ({ page }) => {
        createRequests.length = 0;
        await mockTodoist(page, { containers: 'fail' });
        await openWorkspaceTasks(page);
        const drawer = await openNewTaskDrawer(page, `E2E Todoist inbox ${Date.now()}`);
        await drawer.getByTestId('task-tracker-type-select').selectOption('todoist');
        await drawer.getByRole('button', { name: 'Create new Todoist item' }).click();

        await expect(drawer.getByText(/Could not load projects/)).toBeVisible();
        await drawer.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(drawer.getByTestId('task-tracker-preview')).toContainText(CREATED_ITEM.title);
        expect(createRequests[0]?.['container']).toBeUndefined();
        await drawer.getByRole('button', { name: 'Cancel' }).click();
      },
    },
  ],
};

suiteRunner(TodoistTrackerWorkflow);
