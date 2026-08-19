import { expect, type Page, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner } from '@tkottke90/playwrite-test-runner';

async function mockProviders(page: Page, provider: string, model: string): Promise<void> {
  await page.route('**/api/v1/providers', async (route: Route) => {
    await route.fulfill({
      json: {
        providers: [
          {
            name: provider,
            type: provider,
            defaultModel: model,
            models: [{ id: model, inputPricePerM: 0.15, outputPricePerM: 0.6 }],
          },
        ],
      },
    });
  });
}

export const ChatInterface: TestSuite = {
  id: 1,
  name: 'Chat Interface Tests',
  purpose: 'To validate that the chat/thread interface functions and the user is able to interact with the llm',
  tag: [ TAGS.UserWorkflow ],
  steps: [
    {
      action: 'Open a new thread by clicking on the "New Conversation" button',
      expectedOutcome: 'A new thread is created (unique UUID), there is no chat history, the default model is selected, and the user can send a message',
      tag: [ TAGS.Smoke ],
      test: async ({ page }) => {
        // Configure defaults for checking later
        const defaultProvider = 'openai';
        const defaultModel = 'gpt-4o-mini';

        // Setup a route listener for the LLM Models API (/api/v1/providers) to return a predictable response
        await mockProviders(page, defaultProvider, defaultModel);

        // Goto the Chat Page
        await page.goto('/');
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);

        // Capture the thread id from the URL
        const initialThreadId = new URL(page.url()).pathname.split('/').pop();

        // Click the "New Conversation" button
        await page.getByRole('button', { name: 'New conversation' }).click();
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);
        const newThreadId = new URL(page.url()).pathname.split('/').pop();
        expect(newThreadId, 'A fresh, unique thread id should replace the previous one').not.toBe(
          initialThreadId,
        );

        // Verify the chat history is empty
        await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
        await expect(page.locator('[data-slot="chat-message"]')).toHaveCount(0);

        // Verify the default model is listed in the input section as a chip
        await expect(page.locator('[data-slot="model-chip"]')).toBeVisible();
        await expect(page.locator('[data-slot="model-chip"]')).toHaveText(defaultModel);

        // Focus on the chat input & type in a message
        const chatInput = page.locator('[data-slot="textarea"]');
        await chatInput.click();
        await chatInput.fill('Hello, can you help me with something?');

        // Verify the send button is enabled
        await expect(page.locator('button[aria-label="Send message"]')).toBeEnabled();
      }
    },
    {
      action: 'Send a chat message',
      expectedOutcome: 'The UI properly shows the agent message with the loading animation, then updates to show the response with metrics',
      tag: [ TAGS.Smoke ],
      test: async ({ page }) => {
        // Configure defaults for checking later
        const defaultProvider = 'openai';
        const defaultModel = 'gpt-4o-mini';
        const message = 'Say exactly: pong';

        // Setup a route listener for the LLM Models API (/api/v1/providers) to return a predictable response
        await mockProviders(page, defaultProvider, defaultModel);

        // Setup a route listener for the SSE to mock the API response.
        await page.route('**/api/v1/chat/**', async (route: Route) => {
          const url = new URL(route.request().url());
          if (!/\/api\/v1\/chat\/[^/]+$/.test(url.pathname)) {
            // Not the plain send endpoint (e.g. /retry, /hitl) — pass through untouched.
            await route.fallback();
            return;
          }

          // Small delay before the response starts so the UI has time to
          // render the loading-dots state before content arrives — a fully
          // synchronous fulfill would resolve the whole turn before
          // Playwright ever gets to observe the loading animation.
          await new Promise((resolve) => setTimeout(resolve, 300));

          const events = [
            { type: 'text_delta', messageId: 'mock-msg-1', delta: 'pong' },
            {
              type: 'usage_stats',
              messageId: 'mock-msg-1',
              inputTokens: 6,
              outputTokens: 1,
              tokensPerSecond: 42.5,
              estimatedCostUsd: 0.0004,
            },
            { type: 'stream_done', durationMs: 842, assistantSeq: 2, userSeq: 1 },
          ];

          await route.fulfill({
            contentType: 'text/event-stream',
            body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          });
        });

        // Goto the Chat Page
        await page.goto('/');
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);

        // Click the "New Conversation" button
        await page.getByRole('button', { name: 'New conversation' }).click();
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);

        // Focus on the chat input & type in a message
        const chatInput = page.locator('[data-slot="textarea"]');
        await chatInput.click();
        await chatInput.fill(message);

        // Verify the send button is enabled
        const sendButton = page.locator('button[aria-label="Send message"]');
        await expect(sendButton).toBeEnabled();

        // Press Send button
        await sendButton.click();

        // Verify Agent Message loading (3 dots)
        const assistantMessage = page.locator('[data-testid="assistant-message"]');
        await expect(assistantMessage).toBeVisible();
        await expect(assistantMessage.locator('.animate-bounce').first()).toBeVisible();

        // Wait for agent message to appear
        await expect(assistantMessage.locator('.animate-bounce').first()).not.toBeVisible({
          timeout: 10_000,
        });
        await expect(assistantMessage).toContainText('pong');

        // Verify message includes metrics below the message
        await expect(assistantMessage).toContainText('tok/s');
      }
    }

  ]
}

suiteRunner(ChatInterface);
