import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import {
  commitAll,
  initGitRepo,
  removeWorkspaceDir,
  writeFileDirect,
} from '../lib/workspace-files.js';
import { createWorkspace, deleteWorkspace } from './workspace/utilities.js';

// Verifies issue #193: a workspace whose directory ships Agent Skills under
// .agents/skills/ exposes them in its chat's slash menu, badged as repo
// skills, and they stay scoped to that workspace. The fixture is a real local
// git repository used as the workspace's remoteUrl — `git clone` accepts a
// local path — so this exercises real provisioning and discovery end to end
// with no network access and no mocked API responses. See
// docs/superpowers/specs/2026-09-26-repo-agent-skills-design.md.

const REPO_SKILL = 'hello-repo';

const createdLocations: string[] = [];
const createdWorkspaceIds: string[] = [];
let fixtureRepo: string | null = null;

async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'e2e-repo-skills-'));
  initGitRepo(dir);
  await writeFileDirect(
    dir,
    `.agents/skills/${REPO_SKILL}/SKILL.md`,
    `---\nname: ${REPO_SKILL}\ndescription: Greets from the repository\n---\nSay hello from the repo.\n`,
  );
  commitAll(dir, 'Add repo skill');
  return dir;
}

async function openWorkspaceChat(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspaces/${workspaceId}`);
  await page.getByRole('button', { name: 'Chat' }).click();
  await expect(chatInput(page)).toBeVisible();
}

async function openSlashMenu(page: Page): Promise<void> {
  await chatInput(page).fill('/');
}

function chatInput(page: Page) {
  return page.getByRole('textbox', { name: 'Message...' });
}

function slashMenu(page: Page) {
  return page.locator('[data-slot="chat-input-slash-menu"]');
}

export const RepoAgentSkills: TestSuite = {
  id: 21,
  name: 'Repository Agent Skills',
  purpose:
    "Verify that skills a workspace's repository ships in .agents/skills/ appear in that workspace's chat slash menu with a repo badge — so repo owners can give the agent codebase-specific commands — and that they do not leak into other workspaces.",
  tag: [TAGS.UserWorkflow],
  steps: [
    {
      tag: [TAGS.Smoke],
      action:
        'Create a workspace whose remote is a git repo containing .agents/skills/hello-repo, open its Chat tab, and type "/"',
      expectedOutcome: 'The slash menu lists /hello-repo with a "repo" badge',
      test: async ({ page }, testInfo) => {
        fixtureRepo = await createFixtureRepo();
        const stamp = Date.now();
        const ws = await createWorkspace(
          page.request,
          {
            name: `repo-skills-${stamp}`,
            locationRoot: 'temporary',
            directoryName: `repo-skills-${stamp}`,
            git: true,
            remoteUrl: fixtureRepo,
          },
          createdLocations,
        );
        createdWorkspaceIds.push(ws.id);

        await openWorkspaceChat(page, ws.id);
        await pauseForVideo(page, RepoAgentSkills, testInfo);
        await openSlashMenu(page);

        const item = slashMenu(page)
          .locator('[data-slot="chat-input-slash-menu-item"]')
          .filter({ hasText: `/${REPO_SKILL}` });
        await expect(item).toBeVisible({ timeout: 10_000 });
        await expect(item.locator('[data-slot="card-badge"]')).toHaveText('repo');
      },
    },
    {
      action: 'Create a second workspace with no .agents/skills, open its Chat tab, and type "/"',
      expectedOutcome: '/hello-repo is not listed — repo skills stay scoped to their workspace',
      test: async ({ page }, testInfo) => {
        const stamp = Date.now();
        const ws = await createWorkspace(
          page.request,
          {
            name: `no-repo-skills-${stamp}`,
            locationRoot: 'temporary',
            directoryName: `no-repo-skills-${stamp}`,
          },
          createdLocations,
        );
        createdWorkspaceIds.push(ws.id);

        await openWorkspaceChat(page, ws.id);
        await pauseForVideo(page, RepoAgentSkills, testInfo);
        await openSlashMenu(page);

        // Global skills (create-workspace, create-project) are always seeded,
        // so the menu opens — wait for it before asserting the absence.
        await expect(slashMenu(page)).toBeVisible({ timeout: 10_000 });
        await expect(slashMenu(page)).not.toContainText(`/${REPO_SKILL}`);
      },
    },
  ],
};

test.afterAll(async ({ request }) => {
  for (const id of createdWorkspaceIds) {
    await deleteWorkspace(request, id).catch(() => {});
  }
  for (const location of createdLocations) {
    await removeWorkspaceDir(location);
  }
  if (fixtureRepo) await removeWorkspaceDir(fixtureRepo);
});

suiteRunner(RepoAgentSkills);
