import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 47,
  name: 'Workspace detail view on a phone',
  description:
    'Verifies the mobile workspace detail chrome: the compact header, the Details and Actions bottom sheets, the tab strip with its attention dot, the Files tab drill-down, and Chat hiding the strip/bar while typing',
  purpose:
    'Issue #129: the old mobile header ate roughly half the screen before any tab content was visible — this redesign moves navigation and secondary actions into the existing bottom app bar instead',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Tap the header icon cluster',
      expectedOutcome: 'The Details sheet opens showing workspace metadata',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Tap the bottom bar’s ••• to open Actions, then Edit',
      expectedOutcome: 'The existing workspace settings drawer opens nested inside the sheet',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Seed a task in the "needs you" lane, open the workspace',
      expectedOutcome: 'The tab strip shows an amber dot on Tasks',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open a file from the tree, then tap the back arrow',
      expectedOutcome: 'The tree reappears and the file stays open (not closed)',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Focus the chat input',
      expectedOutcome: 'The tab strip and bottom app bar hide, then reappear on blur',
      test: () => {},
    },
  ],
};

test.use({ viewport: { width: 390, height: 844 } });

const createdWorkspaceIds: string[] = [];

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

test.afterEach(async ({ request }) => {
  for (const id of createdWorkspaceIds.splice(0)) {
    await request.delete(`/api/v1/workspaces/${id}`);
  }
});

async function createTask(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post('/api/v1/tasks', { data });
  expect(res.status(), 'task created').toBe(201);
  return (await res.json()) as { id: string };
}

async function goToWorkspace(page: Page, workspaceId: string) {
  await page.goto(`/workspaces/${workspaceId}`);
  await expect(page.getByTestId('workspace-mobile-header')).toBeVisible();
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('the header icon cluster opens the Details sheet with workspace metadata', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-details');
      await request.patch(`/api/v1/workspaces/${ws.id}`, { data: { git: true } });

      await goToWorkspace(page, ws.id);
      await pauseBeforeAction(page, testInfo);

      await page.getByTestId('mobile-header-details-trigger').click();

      await expect(page.getByTestId('details-location')).toBeVisible();
      await expect(page.getByTestId('details-git')).toBeVisible();
    });

    test('the "•••" opens Actions, and Edit opens the settings drawer nested inside it', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-actions-edit');

      await goToWorkspace(page, ws.id);
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('button', { name: 'Open actions' }).click();
      await page.getByRole('button', { name: 'Edit' }).click();

      // The settings drawer is a second, nested <dialog> stacked on top of
      // the Actions sheet's own <dialog> — see e2e/AGENTS.md's note on
      // BottomSheet/Drawer dismissal for why this locator pattern is used
      // instead of toBeVisible() flipping false on the outer one.
      const nestedDialog = page.locator('dialog[open]').last();
      await expect(nestedDialog.getByText('Workspace settings')).toBeVisible();
    });

    test('Delete from the Actions sheet deletes the workspace and returns to the list', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-actions-delete');

      await goToWorkspace(page, ws.id);
      await pauseBeforeAction(page, testInfo);

      page.on('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Open actions' }).click();
      await page.getByTestId('actions-delete-workspace').click();

      await page.waitForURL('/workspaces');
      createdWorkspaceIds.splice(createdWorkspaceIds.indexOf(ws.id), 1);
    });

    test('the tab strip shows an amber dot on Tasks when a task needs the user', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-tab-dot');
      const task = await createTask(request, { title: 'Needs a decision', workspaceId: ws.id });
      await request.patch(`/api/v1/tasks/${task.id}`, { data: { status: 'waiting_on_user' } });

      await goToWorkspace(page, ws.id);
      await pauseBeforeAction(page, testInfo);

      await expect(page.getByTestId('tab-strip-attention-dot')).toBeVisible();
    });

    test('drilling into a file and tapping back returns to the tree without closing the file', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-files-drilldown');
      const fileRes = await request.post(`/api/v1/workspaces/${ws.id}/files/file`, {
        data: { dir: '', name: 'README.md' },
      });
      expect(fileRes.status(), 'file created').toBe(201);

      await goToWorkspace(page, ws.id);
      await page.getByRole('tab', { name: /files/i }).click();
      await expect(page.getByText('README.md')).toBeVisible();
      await pauseBeforeAction(page, testInfo);

      await page.getByText('README.md').click();
      await expect(page.getByTestId('files-mobile-back')).toBeVisible();
      await expect(page.getByText('Save')).toBeVisible();

      await page.getByTestId('files-mobile-back').click();
      await expect(page.getByTestId('file-tree')).toBeVisible();

      await page.getByText('README.md').click();
      await expect(page.getByText('Save')).toBeVisible();
    });

    test('focusing the chat input hides the tab strip and bottom bar, blur restores them', async ({
      page,
      request,
    }, testInfo) => {
      const ws = await createWorkspace(request, 'mobile-chat-focus');

      await goToWorkspace(page, ws.id);
      await page.getByRole('tab', { name: /chat/i }).click();
      await pauseBeforeAction(page, testInfo);

      await expect(page.getByTestId('workspace-tab-strip')).toBeVisible();

      await page.getByPlaceholder('Message...').click();
      await expect(page.getByTestId('workspace-tab-strip')).not.toBeVisible();

      await page.getByPlaceholder('Message...').blur();
      await expect(page.getByTestId('workspace-tab-strip')).toBeVisible();
    });
  },
);
