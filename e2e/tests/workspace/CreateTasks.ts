import { test, expect, type Locator, type Page } from '@playwright/test';
import { TAGS, TestSuite, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import { execSync } from 'node:child_process';
import { CreatedWorkspace, createWorkspace, deleteWorkspace } from './utilities.js';
import { removeWorkspaceDir } from '../../lib/workspace-files.js';
import { CUSTOM_TAGS } from '../../lib/tags.js';

const createdLocations: string[] = [];
let workspace: CreatedWorkspace | undefined;
let workspaceName = 'wiki-workspace';

// How long a human has, per prompt, to switch the provider/model in the UI
// before actually clicking Send — this suite is run manually against a
// real LLM, so there's no way to bound this to a real response time.
const MANUAL_SEND_TIMEOUT_MS = 10 * 60_000;

// How long to wait for a real LLM turn to finish once it has started.
const RESPONSE_TIMEOUT_MS = 3 * 60_000;

// Fills the chat input, then waits for a human to click Send themselves
// (rather than clicking it here) so they get a chance to switch providers
// or models in the UI first. Detected via the Send button flipping to the
// Stop button, which only happens once a turn actually starts (see
// chat-stop-generation.spec.ts) — so this resumes on the real click, no
// matter who's driving.
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
    `[Auto Task Generation] Ready to send the ${label} — switch the provider/model in the UI if you want, then click Send.`,
  );
  await expect(stopButton).toBeVisible({ timeout: MANUAL_SEND_TIMEOUT_MS });
}

// Instructs the agent to draft a plan and stop for review before doing
// anything — the create_tasks tool should only fire after the follow-up
// prompt below explicitly asks for it.
const FIRST_PROMPT =
  'I want to scaffold a simple Express.js + TypeScript app in this workspace — package.json, ' +
  'tsconfig.json, folder structure, and a basic src/index.ts with one route. Skip any npm ' +
  "install, just get the files in place. Let's talk through the plan before you do anything.";

// Approves the plan from FIRST_PROMPT and asks the agent to turn it into
// tasks, which should trigger the create_tasks tool call.
const SECOND_PROMPT = 'That looks good — go ahead and set that up as tasks.';

export const CreateTask: TestSuite = {
  id: 100,
  name: 'Auto Task Generation',
  purpose: 'To manually test the workspace task creation process - Never used with CI tests',
  tag: [TAGS.UserWorkflow, CUSTOM_TAGS.LLM, CUSTOM_TAGS.LOCAL],
  recordVideo: true,
  beforeAll: async ({ request }) => {
    // Get the current commit sha
    const sha = execSync('git rev-parse --short HEAD').toString().trim();

    // Generate workspace name
    workspaceName = `task-create-${sha}`;

    // Create a dedicated workspace for the test
    workspace = await createWorkspace(
      request,
      {
        name: workspaceName,
        locationRoot: 'temporary',
        directoryName: `auto-create-task-${Date.now()}`,
        git: true,
      },
      createdLocations,
    );
  },
  afterAll: async ({ request }) => {
    if (workspace?.id) {
      // Delete the workspace
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
        // This suite waits on two real LLM turns and pauses twice for a
        // human to manually click Send — comfortably longer than the
        // default per-test budget, even with recordVideo's own 3x
        // test.slow() multiplier. test.setTimeout() extends the one
        // enclosing test() this whole suite runs inside (suiteRunner
        // registers exactly one test() per suite).
        test.setTimeout(30 * 60_000);

        const ws = workspace as CreatedWorkspace;

        await page.goto(`/workspaces/${ws.id}`);

        await pauseForVideo(page, CreateTask, testInfo);
        await expect(page.getByRole('heading', { name: workspaceName })).toBeVisible();
      },
    },
    {
      action: 'Navigate to the Chat tab',
      expectedOutcome: 'The chat input element is present',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateTask, testInfo);
        await page.getByRole('button', { name: 'Chat' }).click();

        await expect(page.locator('[data-slot="textarea"]')).toBeVisible();
      },
    },
    {
      slow: true,
      action: 'Fill in the chat input with the First Prompt, then wait for a human to click Send',
      expectedOutcome:
        'Once Send is clicked the message goes out, and the Send button reappears once the agent responds',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');

        await pauseForVideo(page, CreateTask, testInfo);
        await waitForManualSend(page, chatInput, FIRST_PROMPT, 'First Prompt');

        // Send flips to Stop for the duration of the turn, then back to
        // Send once it's done — checking for Send to reappear (rather than
        // toBeEnabled) is what actually signals the turn finished, since
        // Send comes back disabled whenever the now-cleared input is empty.
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      slow: true,
      action: 'Fill in the chat input with the Second Prompt, then wait for a human to click Send',
      expectedOutcome:
        'The create_tasks tool call appears in the chat, then the Send button reappears',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');

        await pauseForVideo(page, CreateTask, testInfo);
        await waitForManualSend(page, chatInput, SECOND_PROMPT, 'Second Prompt');

        await expect(page.getByText('create_tasks')).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        // Send flips to Stop for the duration of the turn, then back to
        // Send once it's done — checking for Send to reappear (rather than
        // toBeEnabled) is what actually signals the turn finished, since
        // Send comes back disabled whenever the now-cleared input is empty.
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      action: 'Check that the Tasks tab was updated with a count',
      expectedOutcome: 'The Tasks tab label shows a count greater than zero',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateTask, testInfo);
        await expect(page.getByRole('button', { name: /Tasks \([1-9][0-9]*\)/ })).toBeVisible();
      },
    },
    {
      action: 'Check the chat history for an "Automated task started" message',
      expectedOutcome:
        'The marker appears, signalling the created tasks were automatically picked up',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateTask, testInfo);
        await expect(
          page.getByTestId('task-run-marker').filter({ hasText: 'Automated task started' }).first(),
        ).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
  ],
};
