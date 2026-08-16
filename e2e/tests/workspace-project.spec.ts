import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 16,
  name: 'Workspace & Project Lifecycle',
  description:
    'Verifies workspace and project creation via UI, list filtering, detail page, settings, close project, and delete',
  purpose:
    'Automate the manual testing walkthrough for the /workspaces page so regressions in creation, filtering, and CRUD operations are caught before merge',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Create a plain workspace via the New workspace UI form',
      expectedOutcome: 'Workspace appears in the list; form validates required fields',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create a project via the Project mode toggle and form',
      expectedOutcome: 'Redirected to project detail page showing win condition card',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Filter tabs and search on the workspace list',
      expectedOutcome:
        'Projects tab shows only projects; Workspaces tab shows only plain; search filters by name',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'All tab excludes closed projects; Closed tab shows them',
      expectedOutcome: 'Closed project absent from All, present in Closed tab',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Workspace detail overview shows goal text and no project elements',
      expectedOutcome: 'Goal text visible; no Project badge, no Win condition card',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Settings drawer renames the workspace',
      expectedOutcome: 'Detail page heading updates to the new name',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Close project removes the Close project button',
      expectedOutcome: 'Button disappears after confirming close',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Delete workspace navigates back to list and removes entry',
      expectedOutcome: 'Workspace absent from list after deletion',
      test: () => {},
    },
  ],
};

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('creates a plain workspace via the UI form and shows it in the list', async ({
      page,
    }, testInfo) => {
      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('button', { name: 'New workspace' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // Submit with empty name — form should not close
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create workspace' }).click();
      await expect(drawer).toBeVisible();

      // Fill required fields
      await drawer.getByPlaceholder('my-workspace').fill('e2e-ws-ui-create');
      await drawer
        .getByPlaceholder('/home/user/projects/my-workspace')
        .fill('/tmp/e2e-ws-ui-create');
      await drawer
        .getByPlaceholder('What should be accomplished in this workspace?')
        .fill('E2E test goal');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create workspace' }).click();

      // Drawer should close and workspace should appear in the list
      await expect(drawer).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'e2e-ws-ui-create' })).toBeVisible();
    });

    test('creates a project via the UI form and navigates to its detail page', async ({
      page,
    }, testInfo) => {
      await page.goto('/workspaces');

      await page.getByRole('button', { name: 'New workspace' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // Switch to Project mode
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Project' }).click();

      await drawer.getByPlaceholder('my-workspace').fill('e2e-proj-ui-create');
      await drawer
        .getByPlaceholder('/home/user/projects/my-workspace')
        .fill('/tmp/e2e-proj-ui-create');
      await drawer.getByPlaceholder('The project is done when...').fill('All E2E tests pass');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create project' }).click();

      // Should navigate to the new project's detail page
      await page.waitForURL(/\/workspaces\/[^/]+$/);

      // Project badge visible in header
      await expect(page.getByText('Project').first()).toBeVisible();

      // Win condition card shows the value we entered
      await expect(page.locator('[data-testid="win-condition"]')).toContainText(
        'All E2E tests pass',
      );
    });

    test('filter tabs correctly show workspaces vs projects and search filters by name', async ({
      page,
      request,
    }, testInfo) => {
      // Create a plain workspace and a project via API
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'e2e-filter-plain-ws', location: '/tmp/e2e-filter-plain-ws' },
      });
      expect(wsRes.status()).toBe(201);

      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: 'e2e-filter-proj',
          location: '/tmp/e2e-filter-proj',
          winCondition: 'E2E project complete',
        },
      });
      expect(projRes.status()).toBe(201);

      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      // Projects tab: project visible, plain workspace not
      await page.getByRole('button', { name: 'projects' }).click();
      await expect(page.getByRole('link', { name: 'e2e-filter-proj' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'e2e-filter-plain-ws' })).not.toBeVisible();

      // Workspaces tab: plain workspace visible, project not
      await page.getByRole('button', { name: 'workspaces' }).click();
      await expect(page.getByRole('link', { name: 'e2e-filter-plain-ws' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'e2e-filter-proj' })).not.toBeVisible();

      // All tab: both visible
      await page.getByRole('button', { name: 'all' }).click();
      await expect(page.getByRole('link', { name: 'e2e-filter-plain-ws' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'e2e-filter-proj' })).toBeVisible();

      // Search: type partial name to isolate the plain workspace
      await pauseBeforeAction(page, testInfo);
      await page.getByPlaceholder('Search').fill('e2e-filter-plain');
      await expect(page.getByRole('link', { name: 'e2e-filter-plain-ws' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'e2e-filter-proj' })).not.toBeVisible();
    });

    test('All tab excludes closed projects; Closed tab shows them', async ({
      page,
      request,
    }, testInfo) => {
      // Create a project and close it
      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: 'e2e-closed-proj',
          location: '/tmp/e2e-closed-proj',
          winCondition: 'Done',
        },
      });
      expect(projRes.status()).toBe(201);
      const proj = await projRes.json();

      const closeRes = await request.post(`/api/v1/projects/${proj.workspace.id}/close`);
      expect(closeRes.status()).toBe(200);

      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      // All tab (default): closed project should not appear
      await expect(page.getByRole('link', { name: 'e2e-closed-proj' })).not.toBeVisible();

      // Closed tab: should appear
      await page.getByRole('button', { name: 'closed' }).click();
      await expect(page.getByRole('link', { name: 'e2e-closed-proj' })).toBeVisible();
    });

    test('workspace detail overview shows goal text and no project elements', async ({
      page,
      request,
    }, testInfo) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-detail-overview-ws',
          location: '/tmp/e2e-detail-overview-ws',
          goal: 'Verify the overview tab',
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await page.goto(`/workspaces/${ws.id}`);
      await pauseBeforeAction(page, testInfo);

      // Breadcrumb and heading (scope to main to avoid matching the sidebar nav link)
      await expect(page.getByRole('main').getByRole('link', { name: 'Workspaces' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'e2e-detail-overview-ws' })).toBeVisible();

      // Goal text shows in Overview tab
      await expect(page.getByText('Verify the overview tab')).toBeVisible();

      // No project badge, no win condition card
      await expect(page.locator('[data-testid="win-condition"]')).not.toBeVisible();
    });

    test('settings drawer renames the workspace and the heading updates', async ({
      page,
      request,
    }, testInfo) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'e2e-settings-original', location: '/tmp/e2e-settings-original' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await page.goto(`/workspaces/${ws.id}`);

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Edit' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // Pre-filled name is visible
      const nameInput = drawer.getByRole('textbox').first();
      await expect(nameInput).toHaveValue('e2e-settings-original');

      // Read-only section mentions the location
      await expect(drawer.getByText('Read-only after creation')).toBeVisible();

      // Rename
      await nameInput.clear();
      await nameInput.fill('e2e-settings-renamed');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Save changes' }).click();

      // Drawer closes and heading reflects new name
      await expect(drawer).not.toBeVisible();
      await expect(page.getByRole('heading', { name: 'e2e-settings-renamed' })).toBeVisible();
    });

    test('close project removes the Close project button', async ({ page, request }, testInfo) => {
      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: 'e2e-close-proj',
          location: '/tmp/e2e-close-proj',
          winCondition: 'Done when closed',
        },
      });
      expect(projRes.status()).toBe(201);
      const proj = await projRes.json();

      await page.goto(`/workspaces/${proj.workspace.id}`);
      await pauseBeforeAction(page, testInfo);

      const closeBtn = page.getByRole('button', { name: 'Close project' });
      await expect(closeBtn).toBeVisible();

      // Accept the browser confirm dialog
      page.on('dialog', (d) => d.accept());
      await closeBtn.click();

      // Button should disappear after closing
      await expect(closeBtn).not.toBeVisible();
    });

    test('delete workspace navigates back to list and removes the entry', async ({
      page,
      request,
    }, testInfo) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: { name: 'e2e-delete-ws', location: '/tmp/e2e-delete-ws' },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();

      await page.goto(`/workspaces/${ws.id}`);
      await pauseBeforeAction(page, testInfo);

      // Accept the browser confirm dialog
      page.on('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Delete' }).click();

      // Should navigate back to /workspaces
      await page.waitForURL('/workspaces');

      // Workspace should no longer appear in the list
      await expect(page.getByRole('link', { name: 'e2e-delete-ws' })).not.toBeVisible();
    });
  },
);
