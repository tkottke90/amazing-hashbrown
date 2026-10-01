import { test, expect, type Locator, type Page } from '@playwright/test';
import { TAGS, TestSuite, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import { execSync } from 'node:child_process';
import { CreatedWorkspace, createWorkspace, deleteWorkspace } from './utilities.js';
import { removeWorkspaceDir } from '../../lib/workspace-files.js';
import { CUSTOM_TAGS } from '../../lib/tags.js';

const createdLocations: string[] = [];
let workspace: CreatedWorkspace | undefined;
let workspaceName = 'cron-task-workspace';

const MANUAL_SEND_TIMEOUT_MS = 10 * 60_000;
const RESPONSE_TIMEOUT_MS = 3 * 60_000;
// A scheduled task fires on real wall-clock time, not on an agent turn — give
// the real CronRegistry timer and the run it kicks off room to actually
// happen, on top of the usual response timeout.
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
    `[Create Scheduled Tasks] Ready to send the ${label} — switch the provider/model in the UI ` +
      'if you want, then click Send.',
  );
  await expect(stopButton).toBeVisible({ timeout: MANUAL_SEND_TIMEOUT_MS });
}

// A fire time close enough that this suite doesn't sit idle for minutes, but
// far enough out that there's time to click Send first.
function soonIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

export const CreateScheduledTasks: TestSuite = {
  id: 101,
  name: 'Create Scheduled Tasks',
  purpose:
    'To manually verify chat-created cron_once/cron_repeat tasks actually fire on their real ' +
    'schedule, that a scheduled run can still hit a real HITL approval mid-run, and that a ' +
    "cron task gated on a sibling task's success only goes onto its schedule once that sibling " +
    'completes — Never used with CI tests. See ' +
    'docs/superpowers/specs/2026-10-01-chat-scheduled-tasks-design.md.',
  tag: [TAGS.UserWorkflow, CUSTOM_TAGS.LLM, CUSTOM_TAGS.LOCAL],
  recordVideo: true,
  beforeAll: async ({ request }) => {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    workspaceName = `cron-task-${sha}`;
    workspace = await createWorkspace(
      request,
      {
        name: workspaceName,
        locationRoot: 'temporary',
        directoryName: `create-scheduled-tasks-${Date.now()}`,
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
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        await expect(page.getByRole('heading', { name: workspaceName })).toBeVisible();
      },
    },
    {
      action: 'Navigate to the Chat tab',
      expectedOutcome: 'The chat input element is present',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        await page.getByRole('button', { name: 'Chat' }).click();
        await expect(page.locator('[data-slot="textarea"]')).toBeVisible();
      },
    },

    // --- Scenario 1: an immediate-fire cron_once task succeeds end to end ---
    {
      slow: true,
      action: 'Ask the agent (manual send) to create a one-shot task scheduled ~20s out',
      expectedOutcome: 'create_tasks is called and the Send button reappears',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        const fireAt = soonIso(20);
        await waitForManualSend(
          page,
          chatInput,
          'Create a task titled "Scenario 1: one-shot" that just logs a short message — nothing ' +
            `else. Schedule it to run once at exactly ${fireAt} (UTC). Don't run it now.`,
          'Scenario 1 prompt',
        );
        await expect(page.getByText('create_tasks')).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      action: 'Open the Tasks tab and find the Scenario 1 card',
      expectedOutcome: 'The card shows a next-fire time — it is scheduled, not running yet',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        await page.getByRole('button', { name: /Tasks/ }).click();
        const card = page.getByTestId('task-card').filter({ hasText: 'Scenario 1: one-shot' });
        await expect(card).toBeVisible();
        await expect(card.getByTestId('task-card-schedule')).toBeVisible();
      },
    },
    {
      slow: true,
      action: 'Wait for the real CronRegistry to fire the task and the run to finish',
      expectedOutcome: "The card's status badge reaches 'done'",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        const card = page.getByTestId('task-card').filter({ hasText: 'Scenario 1: one-shot' });
        await expect(card.getByTestId('task-card-status')).toHaveText(/done/i, {
          timeout: SCHEDULE_FIRE_TIMEOUT_MS,
        });
      },
    },

    // --- Scenario 2: an immediate-fire cron task's run needs real HITL approval ---
    {
      slow: true,
      action:
        'Ask the agent (manual send) to create a one-shot task scheduled ~20s out whose plan ' +
        'requires a shell-command approval',
      expectedOutcome: 'create_tasks is called and the Send button reappears',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        const fireAt = soonIso(20);
        await waitForManualSend(
          page,
          chatInput,
          'Create a task titled "Scenario 2: needs approval" whose plan is to run a shell ' +
            'command (e.g. `echo hello`) via shell_exec. Schedule it to run once at exactly ' +
            `${fireAt} (UTC).`,
          'Scenario 2 prompt',
        );
        await expect(page.getByText('create_tasks')).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      slow: true,
      action:
        "Wait for the schedule to fire, open the task once it's waiting, and find the real " +
        'approval question',
      // If the UI renders the reply form somewhere other than via the
      // drawer's "Open run" link by the time this runs, adjust the selectors
      // below — this suite is run and watched by a human, not CI.
      expectedOutcome: "The card reaches 'waiting_on_user' and shows a real approval question",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        const card = page
          .getByTestId('task-card')
          .filter({ hasText: 'Scenario 2: needs approval' });
        await expect(card.getByTestId('task-card-status')).toHaveText(/waiting/i, {
          timeout: SCHEDULE_FIRE_TIMEOUT_MS,
        });
        await card.click();
        await page.getByTestId('task-waiting-open-run').click();
        await expect(page.getByTestId('board-reply-question')).toBeVisible({
          timeout: RESPONSE_TIMEOUT_MS,
        });
      },
    },
    {
      action: 'Approve the run through the real UI and confirm it completes',
      expectedOutcome: "The task reaches 'done' after approval",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        await page.getByTestId('board-reply-form').getByRole('button', { name: /yes/i }).click();
        await page.getByRole('button', { name: /Tasks/ }).click();
        const card = page
          .getByTestId('task-card')
          .filter({ hasText: 'Scenario 2: needs approval' });
        await expect(card.getByTestId('task-card-status')).toHaveText(/done/i, {
          timeout: RESPONSE_TIMEOUT_MS,
        });
      },
    },

    // --- Scenario 3: a cron task only schedules once a sibling task succeeds ---
    {
      slow: true,
      action:
        'Ask the agent (manual send) to create two tasks in one batch — a plain task, and a ' +
        'recurring task that depends on it',
      expectedOutcome: 'create_tasks is called once with both tasks in the same batch',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        await waitForManualSend(
          page,
          chatInput,
          'Create two tasks in one batch, in this order: first, "Scenario 3: setup", which just ' +
            'logs a short message and should run right away. Second, "Scenario 3: recurring", ' +
            'which should run every minute — but it must only start its schedule once ' +
            '"Scenario 3: setup" finishes successfully, not before.',
          'Scenario 3 prompt',
        );
        await expect(page.getByText('create_tasks')).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      action: 'Check the recurring task before the setup task finishes',
      expectedOutcome: 'It shows no schedule/next-fire time yet',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        await page.getByRole('button', { name: /Tasks/ }).click();
        const recurringCard = page
          .getByTestId('task-card')
          .filter({ hasText: 'Scenario 3: recurring' });
        await expect(recurringCard).toBeVisible();
        await expect(recurringCard.getByTestId('task-card-schedule')).not.toBeVisible();
      },
    },
    {
      slow: true,
      action: "Wait for the setup task's real run to finish",
      expectedOutcome: "The setup task's card reaches 'done'",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        const setupCard = page.getByTestId('task-card').filter({ hasText: 'Scenario 3: setup' });
        await expect(setupCard.getByTestId('task-card-status')).toHaveText(/done/i, {
          timeout: RESPONSE_TIMEOUT_MS,
        });
      },
    },
    {
      action: 'Confirm the recurring task is now on its schedule',
      expectedOutcome: "The recurring task's card now shows a next-fire time",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateScheduledTasks, testInfo);
        const recurringCard = page
          .getByTestId('task-card')
          .filter({ hasText: 'Scenario 3: recurring' });
        await expect(recurringCard.getByTestId('task-card-schedule')).toBeVisible({
          timeout: RESPONSE_TIMEOUT_MS,
        });
      },
    },
  ],
};
