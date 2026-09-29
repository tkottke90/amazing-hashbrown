import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import { removeWorkspaceDir } from '../lib/workspace-files.js';
import { deleteWorkspace } from './workspace/utilities.js';

// Own spec file (not 003-Workspace.spec.ts): suiteRunner registers a suite's
// hooks at file level, so this suite's afterAll would otherwise run
// alongside — and be affected by — the other suites' hooks in that file.

const workspaceName = `e2e-new-wiki-${randomUUID().slice(0, 8)}`;
// Must match the server's wikiIdFromName() for this name.
const wikiId = workspaceName;
const createdWikiIds: string[] = [];
const createdLocations: string[] = [];
let workspaceId: string | undefined;

async function openCreateForm(page: Page) {
  await page.goto('/workspaces');
  await page.getByRole('button', { name: 'New workspace' }).click();
  const drawer = page.locator('dialog[open]');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function chooseCreateNewWiki(page: Page, drawer: ReturnType<Page['locator']>) {
  const wikiSection = drawer.locator('div', { has: page.getByText('Wiki binding') }).last();
  const trigger = wikiSection.getByRole('combobox');
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole('option', { name: 'Create new wiki…' }).click();
}

async function listDomainIds(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/v1/wiki/domains');
  expect(res.status()).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((d) => d.id);
}

export const WorkspaceDedicatedWiki: TestSuite = {
  id: 45,
  name: 'Workspace Dedicated Wiki',
  purpose:
    'Verify a workspace can create and bind its own persistent wiki from the creation form (issue #202): the wiki is registered as a normal domain, outlives the workspace, and a name that collides with an existing wiki is caught before submit.',
  tag: [TAGS.UserWorkflow],
  recordVideo: true,
  afterAll: async ({ request }) => {
    if (workspaceId) await request.delete(`/api/v1/workspaces/${workspaceId}`);
    for (const id of createdWikiIds) await request.delete(`/api/v1/wiki/domains/${id}`);
    for (const location of createdLocations) await removeWorkspaceDir(location);
  },
  steps: [
    {
      action:
        'Open the New workspace form, enter a name, choose "Create new wiki…" in Wiki binding, and submit',
      expectedOutcome:
        'The Wiki name field is prefilled from the workspace name; the drawer closes and a wiki domain with the derived id is registered',
      test: async ({ page }, testInfo) => {
        const drawer = await openCreateForm(page);
        const nameInput = drawer.getByPlaceholder('my-workspace', { exact: true });
        await nameInput.fill(workspaceName);
        await nameInput.blur();

        await chooseCreateNewWiki(page, drawer);
        await expect(drawer.getByLabel(/Wiki name/)).toHaveValue(workspaceName);
        await expect(
          drawer.getByText('Notes from this workspace are written only to this wiki.'),
        ).toBeVisible();

        await pauseForVideo(page, WorkspaceDedicatedWiki, testInfo);
        await drawer.getByRole('button', { name: 'Create workspace' }).click();
        await expect(drawer).not.toBeVisible();
        createdWikiIds.push(wikiId);

        const res = await page.request.get('/api/v1/workspaces');
        const created = (
          (await res.json()) as Array<{
            id: string;
            name: string;
            location: string;
            wikiId: string | null;
          }>
        ).find((w) => w.name === workspaceName);
        expect(created, 'the workspace should exist').toBeTruthy();
        workspaceId = created!.id;
        createdLocations.push(created!.location);
        expect(created!.wikiId).toBe(wikiId);

        expect(await listDomainIds(page)).toContain(wikiId);
      },
    },
    {
      action: 'Delete the workspace that created the wiki',
      expectedOutcome: 'The workspace is gone but its wiki domain is still registered',
      test: async ({ page }) => {
        await deleteWorkspace(page.request, workspaceId!);
        workspaceId = undefined;

        expect(await listDomainIds(page)).toContain(wikiId);
      },
    },
    {
      action: 'Reopen the form and ask for a new wiki whose name matches the surviving wiki',
      expectedOutcome:
        'An inline "already exists" error names the wiki id and the Create workspace button is disabled',
      test: async ({ page }, testInfo) => {
        const drawer = await openCreateForm(page);
        const nameInput = drawer.getByPlaceholder('my-workspace', { exact: true });
        await nameInput.fill(workspaceName);
        await nameInput.blur();

        await chooseCreateNewWiki(page, drawer);

        await expect(drawer.getByText(`A wiki named "${wikiId}" already exists.`)).toBeVisible();
        await expect(drawer.getByRole('button', { name: 'Create workspace' })).toBeDisabled();
        await pauseForVideo(page, WorkspaceDedicatedWiki, testInfo);
      },
    },
  ],
};

suiteRunner(WorkspaceDedicatedWiki);
