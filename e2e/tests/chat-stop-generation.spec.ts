import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 27,
  name: 'Chat Stop Generation',
  description:
    'Verifies clicking Stop mid-generation actually reaches the server (not just the local UI), terminates the live turn, and — critically — frees the thread up for a new message right away, rather than leaving it stuck rejecting new turns. Issue #196',
  purpose:
    'Before this fix, an abandoned or stopped turn left a thread permanently stuck rejecting new messages with "This workspace has a task running" — a user needs Stop to actually stop generation server-side, and the thread to be immediately usable again',
  tags: ['@user-workflow', '@llm'],
  steps: [
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Send a message that prompts a long response, then click Stop before it finishes',
      expectedOutcome:
        'The assistant bubble reaches a terminal "stopped" state, not left streaming forever',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Immediately send a new message on the same thread',
      expectedOutcome:
        'The new message sends and streams normally — the thread is not stuck rejecting it',
      test: () => {},
    },
  ],
};

test.describe(
  '@user-workflow @llm',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('Stop mid-generation terminates the turn server-side and frees the thread for a new message', async ({
      page,
    }, testInfo) => {
      await page.goto('/');

      // A long-form ask maximizes the window between generation starting and
      // finishing, giving the click below a real chance to land mid-stream
      // against a live (small, local) model.
      await page
        .locator('[data-slot="textarea"]')
        .fill(
          'Write a very long, detailed short story of at least 800 words about a lighthouse keeper. Take your time and be thorough.',
        );
      await pauseBeforeAction(page, testInfo);
      await page.locator('button[aria-label="Send message"]').click();

      const stopBtn = page.locator('button[aria-label="Stop generating"]');
      await expect(stopBtn).toBeVisible({ timeout: 15_000 });
      await pauseBeforeAction(page, testInfo);
      await stopBtn.click();

      // The Send button reappears once generation is no longer live — this
      // is true both for the instant local-UI state flip and once the
      // server-side abort has actually been acted on.
      await expect(page.locator('button[aria-label="Send message"]')).toBeVisible({
        timeout: 10_000,
      });

      // The literal regression test for #196: sending again on the same
      // thread right after Stop must not be rejected — it must actually
      // reach a real turn, not the old "task running" stream_error.
      const followUp = `Are you still there? ${Date.now()}`;
      await page.locator('[data-slot="textarea"]').fill(followUp);
      await pauseBeforeAction(page, testInfo);
      await page.locator('button[aria-label="Send message"]').click();

      await expect(page.getByText('This workspace has a task running')).not.toBeVisible();
      await expect(page.getByText('Something went wrong. Please try again.')).not.toBeVisible({
        timeout: 5_000,
      });

      const followUpAssistant = page.locator('[data-testid="assistant-message"]').last();
      await expect(followUpAssistant).toBeVisible({ timeout: 30_000 });
      // Streaming actually completes rather than hanging — proves the
      // thread's mutex was genuinely free, not just that the POST was accepted.
      await expect(stopBtn).not.toBeVisible({ timeout: 60_000 });
    });
  },
);
