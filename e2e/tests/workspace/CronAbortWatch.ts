import { test, expect, type Locator, type Page } from '@playwright/test';
import { TAGS, TestSuite, pauseForVideo } from '@tkottke90/playwrite-test-runner';
import { execSync } from 'node:child_process';
import { CreatedWorkspace, createWorkspace, deleteWorkspace } from './utilities.js';
import { removeWorkspaceDir } from '../../lib/workspace-files.js';
import { CUSTOM_TAGS } from '../../lib/tags.js';

const createdLocations: string[] = [];
let workspace: CreatedWorkspace | undefined;
let workspaceName = 'abort-watch-workspace';

const MANUAL_SEND_TIMEOUT_MS = 10 * 60_000;
const RESPONSE_TIMEOUT_MS = 3 * 60_000;

// How long to watch the task's real, one-minute schedule fire repeatedly,
// hunting for the "Abort" bug (see error-classification.ts's
// classifyFrameworkAbort comment, and turn-observability.ts's
// warnIfAmbientRunnableConfig — both added during that investigation).
// Exported so a human chasing the bug can raise it for a longer unattended
// sit without editing the watch loop itself; the default gives roughly 9-10
// real firings.
export const WATCH_WINDOW_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;

// Fills the chat input, then waits for a human to click Send themselves —
// same pattern as CreateTasks.ts/CreateScheduledTasks.ts (see either for the
// full rationale): this suite is run and watched by a human, not CI, so
// provider/model can be switched in the UI before the turn actually starts.
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
    `[Cron Abort Watch] Ready to send the ${label} — switch the provider/model in the UI if you want, then click Send.`,
  );
  await expect(stopButton).toBeVisible({ timeout: MANUAL_SEND_TIMEOUT_MS });
}

// Deliberately avoids the word "plan" — create_tasks's `plan` field is
// typed as an array of checklist-step strings (create-tasks.tool.ts), and a
// prompt that says "whose plan is X" invites the model to hand back a bare
// string there instead of an array, which fails the tool's own input schema
// before the run even starts (a real failure hit while manually running
// this suite — see CreateScheduledTasks.ts's Scenario 1/3 prompts, which
// avoid "plan" the same way, for the proven-safe phrasing this now matches).
const PROMPT =
  'Create a task titled "Abort watch" that just logs a short message — nothing else. Schedule ' +
  'it to run every minute, starting now.';

export const CronAbortWatch: TestSuite = {
  id: 102,
  name: 'Cron Abort Watch',
  purpose:
    'Sets up the real-world conditions the "Abort" bug was reported under — a cron_repeat task ' +
    'firing repeatedly against a real provider — and watches it for several minutes. This is NOT ' +
    "a guaranteed repro: the investigation (see error-classification.ts's classifyFrameworkAbort " +
    'comment) narrowed down where LangGraph\'s bare "Abort" error comes from and ruled out several ' +
    'causes, but could not pin the exact trigger without a live environment like this one. What ' +
    'this suite gives you: (1) every diagnostic added during that investigation already wired in — ' +
    "watch the API server's own console for `category`/`elapsedMs` on task-execution.ts's failure " +
    'log, and for a `turn-observability: ambient RunnableConfig present...` warning, which would be ' +
    'the smoking gun; (2) a live assertion that if a run *does* fail, the UI now shows the specific ' +
    "'interrupted' copy (or whatever real category applies) instead of the old generic \"Something " +
    'went wrong" bubble — proving the remediation independent of whether the bug itself reproduces ' +
    'this run. Raise WATCH_WINDOW_MS for a longer unattended sit. Never used with CI tests.',
  tag: [TAGS.UserWorkflow, CUSTOM_TAGS.LLM, CUSTOM_TAGS.LOCAL],
  recordVideo: true,
  // Identical to CreateTasks.ts's own hook — see its comment for the full
  // rationale. Copied wholesale per e2e/AGENTS.md's own guidance: regular
  // Network-tab inspection doesn't show individual SSE frames well, and the
  // app's client silently drops a frame that fails schema validation with no
  // console output, so "no console errors" doesn't rule that out as a cause
  // if a run's failure never reaches the UI the way it's expected to.
  beforeEach: async ({ page }) => {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');

    const sseRequestIds = new Set<string>();

    client.on('Network.responseReceived', (event) => {
      if (event.response.url.endsWith('/api/v1/events')) {
        sseRequestIds.add(event.requestId);
        console.log(
          `[SSE /api/v1/events] connected (status ${event.response.status}) at ${new Date().toISOString()}`,
        );
      }
    });

    client.on('Network.eventSourceMessageReceived', (event) => {
      if (!sseRequestIds.has(event.requestId)) return;
      console.log(
        `[SSE /api/v1/events] frame at ${new Date().toISOString()} — event: ${event.eventName || '(default)'}, data: ${event.data}`,
      );
    });

    client.on('Network.loadingFailed', (event) => {
      if (!sseRequestIds.has(event.requestId)) return;
      console.log(
        `[SSE /api/v1/events] connection failed at ${new Date().toISOString()} — ${event.errorText}`,
      );
    });
  },
  beforeAll: async ({ request }) => {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    workspaceName = `abort-watch-${sha}`;
    workspace = await createWorkspace(
      request,
      {
        name: workspaceName,
        locationRoot: 'temporary',
        directoryName: `abort-watch-${Date.now()}`,
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
        // The watch step alone blocks for WATCH_WINDOW_MS on top of the
        // manual-send pause and the usual response waits — comfortably
        // longer than the default per-test budget, even with recordVideo's
        // own 3x test.slow() multiplier.
        test.setTimeout(WATCH_WINDOW_MS + 20 * 60_000);

        const ws = workspace as CreatedWorkspace;
        await page.goto(`/workspaces/${ws.id}`);
        await pauseForVideo(page, CronAbortWatch, testInfo);
        await expect(page.getByRole('heading', { name: workspaceName })).toBeVisible();
      },
    },
    {
      action: 'Navigate to the Chat tab',
      expectedOutcome: 'The chat input element is present',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CronAbortWatch, testInfo);
        await page.getByRole('button', { name: 'Chat' }).click();
        await expect(page.locator('[data-slot="textarea"]')).toBeVisible();
      },
    },
    {
      slow: true,
      action: 'Ask the agent (manual send) to create a task scheduled to repeat every minute',
      expectedOutcome: 'create_tasks is called and the Send button reappears',
      test: async ({ page }, testInfo) => {
        const chatInput = page.locator('[data-slot="textarea"]');
        const sendButton = page.locator('button[aria-label="Send message"]');
        await pauseForVideo(page, CronAbortWatch, testInfo);
        await waitForManualSend(page, chatInput, PROMPT, 'task-creation prompt');
        await expect(page.getByText('create_tasks')).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
        await expect(sendButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });
      },
    },
    {
      action: 'Open the Tasks tab and find the Abort watch card',
      expectedOutcome: 'The card shows a repeating schedule — it is on its real cron timer',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CronAbortWatch, testInfo);
        await page.getByRole('button', { name: /Tasks/ }).click();
        const card = page.getByTestId('task-card').filter({ hasText: 'Abort watch' });
        await expect(card).toBeVisible();
        await expect(card.getByTestId('task-card-schedule')).toContainText('repeats', {
          timeout: RESPONSE_TIMEOUT_MS,
        });
      },
    },
    {
      slow: true,
      action: `Watch the real schedule fire for up to ${Math.round(WATCH_WINDOW_MS / 60_000)} minutes, logging every run outcome`,
      expectedOutcome:
        "At least two real runs accumulate (the schedule itself works); if any run failed, its transcript shows the classified category's own copy, never the generic fallback",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CronAbortWatch, testInfo);
        const card = page.getByTestId('task-card').filter({ hasText: 'Abort watch' });
        const lastRunBadge = card.getByTestId('task-card-last-run');

        let lastSeen: string | null = null;
        const deadline = Date.now() + WATCH_WINDOW_MS;
        while (Date.now() < deadline) {
          const text = (await lastRunBadge.textContent().catch(() => null)) ?? null;
          if (text && text !== lastSeen) {
            console.log(
              `[Cron Abort Watch] ${new Date().toISOString()} — card now shows "${text}"`,
            );
            lastSeen = text;
          }
          await page.waitForTimeout(POLL_INTERVAL_MS);
        }

        // Open the drawer and read the full run history — the card's own
        // badge only ever shows the *latest* outcome, not how many runs
        // actually happened in the window.
        await card.click();
        const rows = page.getByTestId('task-run-history-row');
        await expect(rows.first()).toBeVisible({ timeout: 10_000 });
        const rowCount = await rows.count();
        console.log(`[Cron Abort Watch] ${rowCount} real run(s) accumulated in the watch window.`);
        expect(
          rowCount,
          'the real CronRegistry should have fired this every-minute schedule at least twice in the watch window — if this fails, the schedule itself is broken, unrelated to the Abort bug',
        ).toBeGreaterThanOrEqual(2);

        const rowTexts = await rows.allTextContents();
        const failedIndex = rowTexts.findIndex((t) => / failed /.test(t) || t.endsWith('failed'));

        if (failedIndex === -1) {
          console.log(
            '[Cron Abort Watch] No failed runs observed in this window — the Abort bug did not ' +
              'reproduce this attempt. Re-run this suite, or raise WATCH_WINDOW_MS, to keep trying.',
          );
          return;
        }

        console.log(
          `[Cron Abort Watch] Run #${failedIndex + 1} from the top failed ("${rowTexts[failedIndex]}") — opening its transcript.`,
        );
        await rows.nth(failedIndex).click();

        const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
        await expect(assistantMsg).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS });

        const genericFallback = assistantMsg.getByText('Something went wrong. Please try again.');
        await expect(
          genericFallback,
          "a real failure must show its classified category's own copy — if this fails, either a new, unclassified error shape showed up, or the fix in error-classification.ts regressed",
        ).not.toBeVisible();

        const shownText = await assistantMsg.textContent();
        console.log(`[Cron Abort Watch] Failed run's transcript shows: "${shownText}"`);
      },
    },
  ],
};
