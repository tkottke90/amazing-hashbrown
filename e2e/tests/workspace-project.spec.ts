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
      expectedOutcome:
        'Redirected to project detail page showing win condition card and a wiki link into the auto-created project wiki',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create a workspace with Git enabled and a remote URL via the New workspace form',
      expectedOutcome:
        'Workspace is created with git=true; the Git chip on its detail page carries the remote URL as a title attribute',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Create a workspace with both dependency isolation checkboxes checked',
      expectedOutcome:
        'Workspace is created with javascript=true and python=true; the detail page shows both isolation chips',
      test: () => {},
    },
    {
      tags: ['@functional'],
      action: 'Create and delete a project via the API',
      expectedOutcome:
        'A project-{id} wiki domain is registered on creation and removed again when the workspace is deleted',
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
      action:
        'Close project walks the full close wizard (snapshot, skip merge, skip cleanup, complete)',
      expectedOutcome:
        'Navigates to /workspaces/:id/close, auto-advances through snapshot and auto-skipped cleanup, and returns to a read-only project detail page after completing',
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

      // Fill required fields — Location defaults to "Projects" and Directory
      // Name auto-derives from Name on blur, so neither needs direct
      // interaction for the happy path.
      const nameInput = drawer.getByPlaceholder('my-workspace', { exact: true });
      await nameInput.fill('e2e-ws-ui-create');
      await nameInput.blur();
      await drawer
        .getByPlaceholder('What should be accomplished in this workspace?')
        .fill('E2E test goal');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create workspace' }).click();

      // Drawer should close and workspace should appear in the list
      await expect(drawer).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'e2e-ws-ui-create' })).toBeVisible();
    });

    test('creates a workspace with Git enabled and shows the remote URL as a tooltip on the detail page', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('button', { name: 'New workspace' }).click();
      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      const nameInput = drawer.getByPlaceholder('my-workspace', { exact: true });
      await nameInput.fill('e2e-ws-git-create');
      await nameInput.blur();

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('switch', { name: 'Git repository' }).click();
      // A real, tiny, stable public repo — creation now actually clones this
      // URL (see #107's fix), so a placeholder/non-existent URL would make
      // the create request fail instead of just being stored as metadata.
      await drawer.getByLabel('Remote URL').fill('https://github.com/octocat/Hello-World');

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create workspace' }).click();
      await expect(drawer).not.toBeVisible();

      await page.getByRole('link', { name: 'e2e-ws-git-create' }).click();
      await page.waitForURL(/\/workspaces\/[^/]+$/);

      await expect(page.getByTestId('git-chip')).toHaveAttribute(
        'title',
        'https://github.com/octocat/Hello-World',
      );

      // Clean up so reruns against a persistent dev server don't collide on
      // the fixed workspace name/directory used above.
      const workspaceId = page.url().match(/\/workspaces\/([^/]+)$/)?.[1];
      expect(workspaceId).toBeTruthy();
      const delRes = await request.delete(`/api/v1/workspaces/${workspaceId}`);
      expect(delRes.status()).toBe(204);
    });

    test('creates a workspace with both isolation checkboxes checked and shows both chips on the detail page', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('button', { name: 'New workspace' }).click();
      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      const nameInput = drawer.getByPlaceholder('my-workspace', { exact: true });
      await nameInput.fill('e2e-ws-isolation-create');
      await nameInput.blur();

      await pauseBeforeAction(page, testInfo);
      await drawer.getByLabel(/JavaScript/).click();
      await drawer.getByLabel(/Python/).click();

      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Create workspace' }).click();
      // Real npm init/venv provisioning runs synchronously in the create
      // request, so this can take noticeably longer than the other
      // (non-provisioning) creation tests' default 5s assertion timeout,
      // especially under concurrent test-worker load.
      await expect(drawer).not.toBeVisible({ timeout: 20_000 });

      await page.getByRole('link', { name: 'e2e-ws-isolation-create' }).click();
      await page.waitForURL(/\/workspaces\/[^/]+$/);

      await expect(page.getByTestId('javascript-chip')).toBeVisible();
      await expect(page.getByTestId('python-chip')).toBeVisible();

      // Clean up so reruns against a persistent dev server don't collide on
      // the fixed workspace name/directory used above.
      const workspaceId = page.url().match(/\/workspaces\/([^/]+)$/)?.[1];
      expect(workspaceId).toBeTruthy();
      const delRes = await request.delete(`/api/v1/workspaces/${workspaceId}`);
      expect(delRes.status()).toBe(204);
    });

    test('creates a workspace with neither isolation checkbox checked and shows neither chip', async ({
      page,
      request,
    }) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-ws-no-isolation',
          locationRoot: 'temporary',
          directoryName: `e2e-ws-no-isolation-${Date.now()}`,
        },
      });
      expect(wsRes.status()).toBe(201);
      const ws = await wsRes.json();
      expect(ws.javascript).toBe(false);
      expect(ws.python).toBe(false);

      await page.goto(`/workspaces/${ws.id}`);

      await expect(page.getByTestId('javascript-chip')).not.toBeVisible();
      await expect(page.getByTestId('python-chip')).not.toBeVisible();

      await request.delete(`/api/v1/workspaces/${ws.id}`);
    });

    test('creates a project via the UI form and navigates to its detail page', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/workspaces');

      await page.getByRole('button', { name: 'New workspace' }).click();

      const drawer = page.locator('dialog[open]');
      await expect(drawer).toBeVisible();

      // Switch to Project mode
      await pauseBeforeAction(page, testInfo);
      await drawer.getByRole('button', { name: 'Project' }).click();

      const projectNameInput = drawer.getByPlaceholder('my-workspace', { exact: true });
      await projectNameInput.fill('e2e-proj-ui-create');
      await projectNameInput.blur();
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

      // The auto-created ephemeral wiki shows as a deep link into the wiki view
      const wikiLink = page.getByTestId('wiki-link');
      await expect(wikiLink).toBeVisible();
      await expect(wikiLink).toHaveAttribute(
        'href',
        /\/wiki\?view=document&domain=project-[0-9a-f-]+&page=index\.md$/,
      );

      // Clean up: deleting the workspace also destroys its wiki domain, so
      // reruns against a persistent dev server don't accumulate wiki dirs.
      const workspaceId = page.url().match(/\/workspaces\/([^/]+)$/)?.[1];
      expect(workspaceId).toBeTruthy();
      const delRes = await request.delete(`/api/v1/workspaces/${workspaceId}`);
      expect(delRes.status()).toBe(204);
    });

    test('project creation registers a wiki domain and deletion removes it', async ({
      request,
    }) => {
      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: `e2e-wiki-lifecycle-${Date.now()}`,
          locationRoot: 'temporary',
          directoryName: `e2e-wiki-lifecycle-${Date.now()}`,
          winCondition: 'Wiki lifecycle verified',
        },
      });
      expect(projRes.status()).toBe(201);
      const proj = await projRes.json();

      // The workspace row carries the auto-provisioned domain id
      expect(proj.workspace.wikiId).toBe(`project-${proj.workspace.id}`);

      // ...and the domain is registered with the wiki registry
      const domainsRes = await request.get('/api/v1/wiki/domains');
      expect(domainsRes.status()).toBe(200);
      const domains = (await domainsRes.json()) as Array<{ id: string }>;
      expect(domains.map((d) => d.id)).toContain(proj.workspace.wikiId);

      // Deleting the workspace destroys the domain again
      const delRes = await request.delete(`/api/v1/workspaces/${proj.workspace.id}`);
      expect(delRes.status()).toBe(204);

      const afterRes = await request.get('/api/v1/wiki/domains');
      const after = (await afterRes.json()) as Array<{ id: string }>;
      expect(after.map((d) => d.id)).not.toContain(proj.workspace.wikiId);
    });

    test('filter tabs correctly show workspaces vs projects and search filters by name', async ({
      page,
      request,
    }, testInfo) => {
      // Create a plain workspace and a project via API
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-filter-plain-ws',
          locationRoot: 'temporary',
          directoryName: 'e2e-filter-plain-ws',
        },
      });
      expect(wsRes.status()).toBe(201);

      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: 'e2e-filter-proj',
          locationRoot: 'temporary',
          directoryName: 'e2e-filter-proj',
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

      // Clean up the project so its auto-created wiki domain is destroyed
      const proj = await projRes.json();
      await request.delete(`/api/v1/workspaces/${proj.workspace.id}`);
    });

    test('All tab excludes closed projects; Closed tab shows them', async ({
      page,
      request,
    }, testInfo) => {
      // Create a project and close it
      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: 'e2e-closed-proj',
          locationRoot: 'temporary',
          directoryName: 'e2e-closed-proj',
          winCondition: 'Done',
        },
      });
      expect(projRes.status()).toBe(201);
      const proj = await projRes.json();

      const closeRes = await request.post(`/api/v1/projects/${proj.workspace.id}/close`, {
        data: { intent: 'close' },
      });
      expect(closeRes.status()).toBe(200);

      await page.goto('/workspaces');
      await pauseBeforeAction(page, testInfo);

      // All tab (default): closed project should not appear
      await expect(page.getByRole('link', { name: 'e2e-closed-proj' })).not.toBeVisible();

      // Closed tab: should appear
      await page.getByRole('button', { name: 'closed' }).click();
      await expect(page.getByRole('link', { name: 'e2e-closed-proj' })).toBeVisible();

      // Clean up the project so its auto-created wiki domain is destroyed
      await request.delete(`/api/v1/workspaces/${proj.workspace.id}`);
    });

    test('workspace detail overview shows goal text and no project elements', async ({
      page,
      request,
    }, testInfo) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-detail-overview-ws',
          locationRoot: 'temporary',
          directoryName: 'e2e-detail-overview-ws',
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
        data: {
          name: 'e2e-settings-original',
          locationRoot: 'temporary',
          directoryName: 'e2e-settings-original',
        },
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

    test('close project walks the full wizard: snapshot, skip merge, skip cleanup, complete', async ({
      page,
      request,
    }, testInfo) => {
      const projRes = await request.post('/api/v1/projects', {
        data: {
          name: 'e2e-close-proj',
          locationRoot: 'temporary',
          directoryName: 'e2e-close-proj',
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

      // Navigates to the close wizard
      await page.waitForURL(`/workspaces/${proj.workspace.id}/close`);
      await pauseBeforeAction(page, testInfo);

      // Step 1 (wiki snapshot) runs automatically and advances to Step 2
      await expect(page.getByRole('heading', { name: 'Selective merge' })).toBeVisible();
      await page.getByRole('button', { name: 'Skip this step' }).click();

      // Step 3 (dependency cleanup) — no js/python flags set, so it
      // auto-skips straight to Step 4.
      await expect(page.getByRole('heading', { name: 'Review & close' })).toBeVisible();
      await expect(page.getByText('No pages merged')).toBeVisible();
      await expect(page.getByText('No cleanup performed')).toBeVisible();

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Complete close' }).click();

      // Redirects back to the now-read-only project detail page
      await page.waitForURL(`/workspaces/${proj.workspace.id}`);
      await expect(page.getByRole('button', { name: 'Close project' })).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

      // Clean up the project so its auto-created wiki domain is destroyed
      await request.delete(`/api/v1/workspaces/${proj.workspace.id}`);
    });

    test('delete workspace navigates back to list and removes the entry', async ({
      page,
      request,
    }, testInfo) => {
      const wsRes = await request.post('/api/v1/workspaces', {
        data: {
          name: 'e2e-delete-ws',
          locationRoot: 'temporary',
          directoryName: 'e2e-delete-ws',
        },
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
