import { expect, test, type Page } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

// This suite exercises the built-in GitHub tracker adapter against the real
// GitHub API — no mocking of /api/v1/trackers/** — so it needs real
// credentials:
//
//   E2E_GITHUB_TOKEN     A personal access token with `repo` (or
//                        `public_repo`) scope. Used both to configure the
//                        tracker through the Settings UI and to clean up the
//                        issue this suite creates.
//   E2E_GITHUB_TEST_REPO A "owner/repo" the token can create issues in
//                        (e.g. a scratch repo dedicated to e2e runs).
//
// Without both set, the whole suite is skipped (see `skip` below) rather
// than failing — CI runs it as a no-op until those secrets are configured.
const GITHUB_TOKEN = process.env['E2E_GITHUB_TOKEN'];
const TEST_REPO = process.env['E2E_GITHUB_TEST_REPO'];

// Populated by step 2, read by later steps and the cleanup afterAll.
let createdIssueUrl = '';
let createdIssueNumber: number | null = null;
let workspaceTasksUrl = '';

function issueNumberFromUrl(url: string): number {
  const match = /\/issues\/(\d+)/.exec(url);
  if (!match || !match[1]) throw new Error(`Could not parse an issue number out of "${url}"`);
  return Number(match[1]);
}

async function openTrackersSettings(page: Page): Promise<void> {
  await page.goto('/settings?section=workspaces');
  await expect(page.locator('[data-slot="tracker-row"]', { hasText: 'GitHub' })).toBeVisible();
}

// Cleanup lives in a plain, fixture-free afterAll — deliberately not routed
// through the suite's own beforeAll/afterAll (which are typed to receive a
// `page`, a Playwright test-scoped fixture that worker-scoped beforeAll/
// afterAll hooks cannot actually depend on). A zero-argument hook sidesteps
// that entirely. It only closes the GitHub issue created by step 2 — if an
// earlier step fails before step 4 removes the configured token, that local
// config state simply gets overwritten by the next full run's step 1/4.
test.afterAll(async () => {
  if (!GITHUB_TOKEN || !TEST_REPO || createdIssueNumber === null) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${TEST_REPO}/issues/${createdIssueNumber}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ state: 'closed' }),
    });
    if (!res.ok) {
      console.warn(`[002-GitHubTrackerWorkflow] cleanup: failed to close issue #${createdIssueNumber} (${res.status})`);
    }
  } catch (err) {
    console.warn('[002-GitHubTrackerWorkflow] cleanup: failed to close created issue', err);
  }
});

export const GitHubTrackerWorkflow: TestSuite = {
  id: 2,
  name: 'GitHub Tracker Workflow',
  purpose:
    'Verify the built-in GitHub tracker adapter end-to-end against the real GitHub API: configuring and removing a personal access token via Settings, creating a new GitHub issue from the task drawer, and linking a task to an existing GitHub issue.',
  tag: [TAGS.UserWorkflow],
  recordVideo: true,
  skip: () =>
    !GITHUB_TOKEN || !TEST_REPO
      ? 'Set E2E_GITHUB_TOKEN (a PAT with repo scope) and E2E_GITHUB_TEST_REPO (owner/repo) to run this suite against the real GitHub API.'
      : false,
  steps: [
    {
      action: 'Configure a GitHub personal access token in Settings',
      expectedOutcome:
        'The token is verified as connected with create-issue access, and persists across a reload',
      tag: [TAGS.Smoke],
      test: async ({ page }, testInfo) => {
        await openTrackersSettings(page);

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await page
          .locator('[data-slot="tracker-row"]', { hasText: 'GitHub' })
          .getByRole('button', { name: 'Configure' })
          .click();

        const dialog = page.locator('dialog[open]');
        await expect(dialog).toBeVisible();
        await dialog.getByLabel('Personal access token').fill(GITHUB_TOKEN!);

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await dialog.getByRole('button', { name: 'Verify' }).click();
        const verifyResult = dialog.getByText(/Connected —/);
        await expect(verifyResult).toBeVisible({ timeout: 15_000 });
        await expect(
          verifyResult,
          'E2E_GITHUB_TOKEN needs `repo` (or `public_repo`) scope for this suite to create issues later',
        ).toContainText('create issues enabled');

        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).not.toBeVisible();

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();

        // Reload and reopen to confirm the token actually persisted server-side.
        await page.reload();
        await openTrackersSettings(page);
        await page
          .locator('[data-slot="tracker-row"]', { hasText: 'GitHub' })
          .getByRole('button', { name: 'Configure' })
          .click();
        await expect(page.getByText('Currently set')).toBeVisible();
        await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
      },
    },
    {
      action: 'Create a task and create a linked GitHub issue for it',
      expectedOutcome: 'A real GitHub issue is created in the test repo and auto-linked to the task',
      test: async ({ page }, testInfo) => {
        const wsRes = await page.request.post('/api/v1/workspaces', {
          data: {
            name: `tracker-e2e-${Date.now()}`,
            location: `/tmp/tracker-e2e-${Date.now()}`,
            remoteUrl: `https://github.com/${TEST_REPO}`,
          },
        });
        expect(wsRes.status()).toBe(201);
        const ws = await wsRes.json();

        await page.goto(`/workspaces/${ws.id}`);
        await page.getByRole('button', { name: /tasks/i }).click();
        workspaceTasksUrl = page.url();

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await page.getByRole('button', { name: 'Add task' }).click();
        const drawer = page.locator('dialog[open]');
        await expect(drawer).toBeVisible();

        const taskTitle = `E2E tracker test — created issue ${Date.now()}`;
        await drawer.locator('input[placeholder="Task title"]').fill(taskTitle);

        await drawer.getByTestId('task-tracker-type-select').selectOption('github');

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await drawer.getByRole('button', { name: 'Create new issue' }).click();

        // The repo field should already be prefilled from the workspace's
        // remoteUrl — confirm the prefill worked rather than typing over it.
        await expect(drawer.locator('input[placeholder="owner/repo"]')).toHaveValue(TEST_REPO!);
        await drawer.locator('input[placeholder="Issue title"]').fill(taskTitle);

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await drawer.getByRole('button', { name: 'Create issue' }).click();

        const preview = drawer.getByTestId('task-tracker-preview');
        await expect(preview).toBeVisible({ timeout: 15_000 });
        await expect(preview).toContainText(taskTitle);

        createdIssueUrl = (await preview.locator('a').getAttribute('href')) ?? '';
        expect(createdIssueUrl, 'the created issue preview should link back to a real GitHub URL').toMatch(
          /^https:\/\/github\.com\/.+\/issues\/\d+$/,
        );
        createdIssueNumber = issueNumberFromUrl(createdIssueUrl);

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await drawer.getByRole('button', { name: 'Create task' }).click();

        const taskCard = page
          .locator('[data-column="pending"]')
          .locator('[data-testid="task-card"]')
          .filter({ hasText: taskTitle });
        await expect(taskCard).toBeVisible();
      },
    },
    {
      action: 'Create a second task and link it to the existing GitHub issue by URL',
      expectedOutcome:
        'Pasting the issue URL resolves a live preview, and the link persists after closing and reopening the task',
      test: async ({ page }, testInfo) => {
        expect(createdIssueUrl, 'previous step should have captured a created issue URL').not.toBe('');

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await page.getByRole('button', { name: 'Add task' }).click();
        const drawer = page.locator('dialog[open]');
        await expect(drawer).toBeVisible();

        const taskTitle = `E2E tracker test — linked existing issue ${Date.now()}`;
        await drawer.locator('input[placeholder="Task title"]').fill(taskTitle);
        await drawer.getByTestId('task-tracker-type-select').selectOption('github');

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await drawer.locator('input[placeholder="Paste a tracker URL to link it"]').fill(createdIssueUrl);

        const preview = drawer.getByTestId('task-tracker-preview');
        await expect(preview).toBeVisible({ timeout: 15_000 });
        await expect(preview.locator('a')).toHaveAttribute('href', createdIssueUrl);

        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await drawer.getByRole('button', { name: 'Create task' }).click();

        const taskCard = page
          .locator('[data-column="pending"]')
          .locator('[data-testid="task-card"]')
          .filter({ hasText: taskTitle });
        await expect(taskCard).toBeVisible();

        // Reopen to confirm the link (and its live-fetched state) survived a
        // full close/reopen round trip, not just local drawer state.
        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await taskCard.click();
        const reopenedPreview = page.locator('dialog[open]').getByTestId('task-tracker-preview');
        await expect(reopenedPreview).toBeVisible({ timeout: 15_000 });
        await expect(reopenedPreview.locator('a')).toHaveAttribute('href', createdIssueUrl);
        await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
      },
    },
    {
      action: 'Remove the GitHub personal access token',
      expectedOutcome:
        'The token no longer shows as configured, and "Create new issue" is hidden in the task drawer — while linking still works unauthenticated',
      test: async ({ page }, testInfo) => {
        await openTrackersSettings(page);
        await page
          .locator('[data-slot="tracker-row"]', { hasText: 'GitHub' })
          .getByRole('button', { name: 'Configure' })
          .click();

        const dialog = page.locator('dialog[open]');
        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await dialog.getByRole('button', { name: 'Remove' }).click();
        await expect(dialog.getByText('Will be removed on save')).toBeVisible();

        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByRole('button', { name: 'Save changes' })).not.toBeVisible();

        // Reload and reconfirm removal actually persisted server-side.
        await page.reload();
        await openTrackersSettings(page);
        await page
          .locator('[data-slot="tracker-row"]', { hasText: 'GitHub' })
          .getByRole('button', { name: 'Configure' })
          .click();
        await expect(page.getByText('Currently set')).not.toBeVisible();
        await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();

        // A fresh task drawer should no longer offer "Create new issue" —
        // and pasting the same issue URL should still resolve unauthenticated.
        expect(workspaceTasksUrl, 'step 2 should have captured the workspace tasks URL').not.toBe('');
        await page.goto(workspaceTasksUrl);
        await pauseForVideo(page, GitHubTrackerWorkflow, testInfo);
        await page.getByRole('button', { name: 'Add task' }).click();
        const drawer = page.locator('dialog[open]');
        await drawer.getByTestId('task-tracker-type-select').selectOption('github');

        await expect(drawer.getByRole('button', { name: 'Create new issue' })).not.toBeVisible();

        await drawer.locator('input[placeholder="Paste a tracker URL to link it"]').fill(createdIssueUrl);
        const preview = drawer.getByTestId('task-tracker-preview');
        await expect(preview).toBeVisible({ timeout: 15_000 });

        await drawer.getByRole('button', { name: 'Cancel' }).click();
      },
    },
  ],
};

suiteRunner(GitHubTrackerWorkflow);
