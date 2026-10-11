import { test, expect, type Locator, type Page } from '@playwright/test';
import { TAGS, TestSuite, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import { execSync } from 'node:child_process';
import { CreatedWorkspace, createWorkspace, deleteWorkspace } from './utilities.js';
import { removeWorkspaceDir } from '../../lib/workspace-files.js';
import { CUSTOM_TAGS } from '../../lib/tags.js';

const createdLocations: string[] = [];
let workspace: CreatedWorkspace | undefined;
let workspaceName = 'cohort-gating-workspace';

const MANUAL_SEND_TIMEOUT_MS = 10 * 60_000;
const RESPONSE_TIMEOUT_MS = 3 * 60_000;
// Same reasoning as CreateScheduledTasks.ts's SCHEDULE_FIRE_TIMEOUT_MS — a
// real CronRegistry timer, not an agent turn, is what starts the clock here.
const SCHEDULE_FIRE_TIMEOUT_MS = 5 * 60_000;

async function waitForManualSend(
  page: Page,
  chatInput: Locator,
  prompt: string,
  label: string,
): Promise<void> {
  const sendButton = page.locator('button[aria-label="Send message"]');
  const stopButton = page.locator('button[aria-label="Stop generating"]');

  await chatInput.click();
  await chatInput.fill(prompt);
  await expect(sendButton).toBeEnabled();

  console.log(
    `[Cron Cohort Gating] Ready to send the ${label} — switch the provider/model in the UI ` +
      'if you want, then click Send.',
  );
  await expect(stopButton).toBeVisible({ timeout: MANUAL_SEND_TIMEOUT_MS });
}

// A fire time close enough that this suite doesn't sit idle for minutes, but
// far enough out that there's time to click Send first.
function soonIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

export const CohortGating: TestSuite = {
  id: 103,
  name: 'Cron Cohort Gating',
  purpose:
    'To manually verify the real pipeline this feature depends on end to end: a real ' +
    "model, told a cron task's own instructions, actually calls " +
    'create_tasks(asCohort: true) with its children when the schedule fires; the ' +
    'orchestrator holds at blocked/awaiting_children with the right "N of M" badge; its ' +
    'two children run one at a time, in order, through the ordinary one-off queue; and ' +
    'the orchestrator returns to its schedule — with a real next-fire time — only once ' +
    "the last child settles. None of this (a real model's tool-calling decision, real " +
    'wall-clock cron firing, real queue ordering) is reachable from a unit or ' +
    'orchestration test. Never used with CI tests. See ' +
    'docs/superpowers/specs/2026-10-11-cron-cohort-gating-design.md.',
  tag: [TAGS.UserWorkflow, CUSTOM_TAGS.LLM, CUSTOM_TAGS.LOCAL],
  recordVideo: true,
  beforeAll: async ({ request }) => {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    workspaceName = `cohort-gating-${sha}`;
    workspace = await createWorkspace(
      request,
      {
        name: workspaceName,
        locationRoot: 'temporary',
        directoryName: `cohort-gating-${Date.now()}`,
        git: true,
      },
      createdLocations,
    );
  },
  afterAll: async ({ request }) => {
    if (workspace?.id) {
      await deleteWorkspace(request, workspace.id);
    }
    if (workspace?.location) {
      await removeWorkspaceDir(workspace.location);
    }
  },
  steps: [
    {
      action: 'Open the Workspace page via its browser URL /workspaces/{id}',
      expectedOutcome: 'The page loads and its heading matches the workspace name',
      test: async ({ page }, testInfo) => {
        test.setTimeout(30 * 60_000);
        const ws = workspace as CreatedWorkspace;
        await page.goto(`/workspaces/${ws.id}`);
        await pauseForVideo(page, CohortGating, testInfo);
        await expect(page.getByRole('heading', { name: workspaceName })).toBeVisible();
      },
    },
    {
      action: 'Navigate to the Chat tab',
      expectedOutcome: 'The chat input element is present',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CohortGating, testInfo);
        await page.getByRole('button', { name: 'Chat' }).click();
        await expect(page.locator('[data-slot="textarea"]')).toBeVisible();
      },
    },
    {
      slow: true,
      action:
        'Ask the agent (manual send) to create a one-shot orchestrator task that, on firing, ' +
        'fans out into two cohort-gated children',
      expectedOutcome: 'create_tasks is called and the Send button reappears',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');
        await pauseForVideo(page, CohortGating, testInfo);
        const fireAt = soonIso(20);
        await waitForManualSend(
          page,
          chatInput,
          'Create a task titled "Cohort orchestrator" scheduled to run once at exactly ' +
            `${fireAt} (UTC). Don't run it now. Its plan: when this task runs, call ` +
            'create_tasks with asCohort: true and exactly two simple tasks in the same batch — ' +
            '"Cohort child A" and "Cohort child B" — each of which should just log a short ' +
            'message and run immediately (no trigger). Do not create the children now; only the ' +
            'orchestrator itself, with that plan, should be created in this turn.',
          'orchestrator prompt',
        );
        await expect(page.getByText('create_tasks')).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      action: 'Open the Tasks tab and find the orchestrator card before it fires',
      expectedOutcome: 'The card shows a next-fire time — it is scheduled, not running yet',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CohortGating, testInfo);
        await page.getByRole('button', { name: /Tasks/ }).click();
        const card = page.getByTestId('task-card').filter({ hasText: 'Cohort orchestrator' });
        await expect(card).toBeVisible();
        await expect(card.getByTestId('task-card-schedule')).toBeVisible();
      },
    },
    {
      slow: true,
      action:
        'Wait for the real CronRegistry to fire the orchestrator and the real model to call ' +
        'create_tasks(asCohort: true)',
      expectedOutcome:
        "The orchestrator's card reaches 'blocked' with a \"0 of 2\" reason line, and both " +
        'children appear on the board',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CohortGating, testInfo);
        const orchestratorCard = page
          .getByTestId('task-card')
          .filter({ hasText: 'Cohort orchestrator' });
        await expect(orchestratorCard.getByTestId('task-card-status')).toHaveText(/blocked/i, {
          timeout: SCHEDULE_FIRE_TIMEOUT_MS,
        });
        await expect(orchestratorCard.getByTestId('task-card-reason')).toHaveText(/0 of 2 done/i);

        await expect(
          page.getByTestId('task-card').filter({ hasText: 'Cohort child A' }),
        ).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        await expect(
          page.getByTestId('task-card').filter({ hasText: 'Cohort child B' }),
        ).toBeVisible();
      },
    },
    {
      slow: true,
      action: 'Wait for the first child to finish and confirm the second has not finished yet',
      expectedOutcome:
        "Child A reaches 'done' while Child B is still not — proving they run one at a time, " +
        'through the ordinary one-off queue, not in parallel',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CohortGating, testInfo);
        const childA = page.getByTestId('task-card').filter({ hasText: 'Cohort child A' });
        const childB = page.getByTestId('task-card').filter({ hasText: 'Cohort child B' });
        await expect(childA.getByTestId('task-card-status')).toHaveText(/done/i, {
          timeout: RESPONSE_TIMEOUT_MS,
        });
        await expect(childB.getByTestId('task-card-status')).not.toHaveText(/done/i);
      },
    },
    {
      slow: true,
      action:
        'Wait for the second child to finish, then confirm the orchestrator returns to its ' +
        'schedule',
      expectedOutcome:
        "Child B reaches 'done', the task_cohorts row is released, and the orchestrator's card " +
        'shows a real next-fire time again instead of the "N of 2" reason line',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CohortGating, testInfo);
        const childB = page.getByTestId('task-card').filter({ hasText: 'Cohort child B' });
        await expect(childB.getByTestId('task-card-status')).toHaveText(/done/i, {
          timeout: RESPONSE_TIMEOUT_MS,
        });

        const orchestratorCard = page
          .getByTestId('task-card')
          .filter({ hasText: 'Cohort orchestrator' });
        await expect(orchestratorCard.getByTestId('task-card-status')).toHaveText(/scheduled/i, {
          timeout: RESPONSE_TIMEOUT_MS,
        });
        await expect(orchestratorCard.getByTestId('task-card-schedule')).toBeVisible();
      },
    },
  ],
};
