import { expect, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

// Issue #191: a chat turn whose live stream drops (idle timeout during a long
// tool call, proxy reset) used to show "Couldn't reach the provider — check
// your connection." even though the provider was fine and the server kept
// working. It must now say the live connection was lost. The chat POST is
// aborted with page.route() — the turn never reaches the server, which is
// exactly what the browser sees when a connection is cut.
export const ChatConnectionLost: TestSuite = {
  id: 43,
  name: 'Chat Connection Lost',
  purpose:
    'A dropped connection to our own server is not a provider failure; telling the user the provider is unreachable sends them debugging the wrong thing while the agent may still be working.',
  tag: [TAGS.UserWorkflow],
  steps: [
    {
      tag: [TAGS.Smoke],
      action: "Send a chat message whose request is cut off before the server's stream arrives",
      expectedOutcome:
        'The reply bubble explains the live connection was lost and the agent may still be working — not that the provider is unreachable',
      test: async ({ page }, testInfo) => {
        await page.route('**/api/v1/chat/**', async (route: Route) => {
          const url = new URL(route.request().url());
          if (
            route.request().method() !== 'POST' ||
            !/\/api\/v1\/chat\/[^/]+$/.test(url.pathname)
          ) {
            await route.continue();
            return;
          }
          await route.abort('connectionreset');
        });
        await page.goto('/');

        await page
          .locator('[data-slot="textarea"]')
          .fill('Run the full test suite and report back');
        await pauseForVideo(page, ChatConnectionLost, testInfo);
        await page.locator('button[aria-label="Send message"]').click();

        const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
        await expect(
          assistantMsg.getByText(
            'Lost the live connection to the server. The agent may still be working — this thread will refresh when it finishes.',
          ),
        ).toBeVisible({ timeout: 15_000 });
        await expect(assistantMsg.getByText(/Couldn't reach the provider/)).toHaveCount(0);
      },
    },
  ],
};

suiteRunner(ChatConnectionLost);
