import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

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

// Top edge of a locator's bounding box, for asserting chronological
// (top-to-bottom) render order between otherwise-unrelated elements.
async function topY(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no bounding box — is it visible?');
  return box.y;
}

export const ChatInterface: TestSuite = {
  id: 1,
  name: 'Chat Interface Tests',
  purpose:
    'To validate that the chat/thread interface functions and the user is able to interact with the llm',
  tag: [TAGS.UserWorkflow],
  recordVideo: true,
  steps: [
    {
      action: 'Open a new thread by clicking on the "New Conversation" button',
      expectedOutcome:
        'A new thread is created (unique UUID), there is no chat history, the default model is selected, and the user can send a message',
      tag: [TAGS.Smoke],
      test: async ({ page }, testInfo) => {
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
        await pauseForVideo(page, ChatInterface, testInfo);
        await page.getByRole('button', { name: 'New conversation' }).click();
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);
        const newThreadId = new URL(page.url()).pathname.split('/').pop();
        expect(newThreadId, 'A fresh, unique thread id should replace the previous one').not.toBe(
          initialThreadId,
        );

        // Verify the chat history is empty
        await pauseForVideo(page, ChatInterface, testInfo);
        await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
        await expect(page.locator('[data-slot="chat-message"]')).toHaveCount(0);

        // Verify the default model is listed in the input section as a chip
        await pauseForVideo(page, ChatInterface, testInfo);
        await expect(page.locator('[data-slot="model-chip"]')).toBeVisible();
        await expect(page.locator('[data-slot="model-chip"]')).toHaveText(defaultModel);

        // Focus on the chat input & type in a message
        const chatInput = page.locator('[data-slot="textarea"]');
        await chatInput.click();
        await chatInput.fill('Hello, can you help me with something?');

        // Verify the send button is enabled
        await pauseForVideo(page, ChatInterface, testInfo);
        await expect(page.locator('button[aria-label="Send message"]')).toBeEnabled();
      },
    },
    {
      action: 'Send a chat message',
      expectedOutcome:
        'The UI properly shows the agent message with the loading animation, then updates to show the response with metrics',
      tag: [TAGS.Smoke],
      test: async ({ page }, testInfo) => {
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
        await pauseForVideo(page, ChatInterface, testInfo);
        await page.getByRole('button', { name: 'New conversation' }).click();
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);

        // Focus on the chat input & type in a message
        const chatInput = page.locator('[data-slot="textarea"]');
        await chatInput.click();
        await chatInput.fill(message);

        // Verify the send button is enabled
        await pauseForVideo(page, ChatInterface, testInfo);
        const sendButton = page.locator('button[aria-label="Send message"]');
        await expect(sendButton).toBeEnabled();

        // Press Send button
        await pauseForVideo(page, ChatInterface, testInfo);
        await sendButton.click();

        // Verify Agent Message loading (3 dots)
        //
        // No pauseForVideo here (or before the wait below): the dots are a
        // transient state that self-clears within ~300ms per the mocked
        // SSE's own artificial delay above — pausing first would let them
        // come and go before we ever check, same reasoning as the SSE
        // delay's own comment.
        const assistantMessage = page.locator('[data-testid="assistant-message"]');
        await expect(assistantMessage).toBeVisible();
        await expect(assistantMessage.locator('.animate-bounce').first()).toBeVisible();

        // Wait for agent message to appear
        await expect(assistantMessage.locator('.animate-bounce').first()).not.toBeVisible({
          timeout: 10_000,
        });
        await expect(assistantMessage).toContainText('pong');

        // Verify message includes metrics below the message
        await pauseForVideo(page, ChatInterface, testInfo);
        await expect(assistantMessage).toContainText('tok/s');
      },
    },
    {
      action: 'Reload the page after a chat message that carries cost/duration/token metrics',
      expectedOutcome:
        'The metrics row (duration, tok/s, cost, and token breakdown) survives a full page reload — rendered from the persisted thread payload, not just the live streamed turn (see issue #131)',
      tag: [TAGS.Smoke],
      test: async ({ page }, testInfo) => {
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

          // Same pacing rationale as the "Send a chat message" step above —
          // gives the loading state a moment to actually render.
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
        await pauseForVideo(page, ChatInterface, testInfo);
        await page.getByRole('button', { name: 'New conversation' }).click();
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);
        const threadId = new URL(page.url()).pathname.split('/').pop();

        // Focus on the chat input & type in a message
        const chatInput = page.locator('[data-slot="textarea"]');
        await chatInput.click();
        await chatInput.fill(message);

        // Press Send button
        await pauseForVideo(page, ChatInterface, testInfo);
        const sendButton = page.locator('button[aria-label="Send message"]');
        await expect(sendButton).toBeEnabled();
        await sendButton.click();

        // Wait for the live turn to complete and show its metrics row —
        // confirms the live path still works before we test the reload path.
        const assistantMessage = page.locator('[data-testid="assistant-message"]');
        await expect(assistantMessage.locator('.animate-bounce').first()).not.toBeVisible({
          timeout: 10_000,
        });
        await expect(assistantMessage).toContainText('pong');
        await expect(assistantMessage).toContainText('tok/s');

        // Now mock the hydrate GET a fresh page load makes (use-thread.ts's
        // hydrate()), returning the exact flat-sibling shape
        // finalizeAssistant persists (durationMs/usage/cost alongside
        // content/sentAt — see thread-message-writer.ts). Registered only
        // now, after the live turn above, so the *first* hydrate on initial
        // page load (an empty, freshly-created thread) is unaffected.
        await page.route(`**/api/v1/threads/${threadId}`, async (route: Route) => {
          if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
          }
          await route.fulfill({
            json: {
              messages: [
                {
                  id: 'mock-user-1',
                  kind: 'user',
                  content: message,
                  sentAt: '2026-09-04T12:00:00.000Z',
                  seq: 1,
                },
                {
                  id: 'mock-msg-1',
                  kind: 'assistant',
                  status: 'done',
                  content: 'pong',
                  sentAt: '2026-09-04T12:00:01.000Z',
                  seq: 2,
                  durationMs: 842,
                  usage: { inputTokens: 6, outputTokens: 1 },
                  cost: { tokensPerSecond: 42.5, dollars: 0.0004 },
                },
              ],
            },
          });
        });

        // A full page reload — the live SSE session is gone, so anything
        // still showing must have come from the hydrate response above.
        await page.reload();

        const reloadedAssistantMessage = page.locator('[data-testid="assistant-message"]');
        await expect(reloadedAssistantMessage).toContainText('pong');

        // Verify duration, tok/s, cost, and the token breakdown all survived
        // the reload, sourced purely from the persisted payload.
        await pauseForVideo(page, ChatInterface, testInfo);
        await expect(reloadedAssistantMessage).toContainText('0.8s');
        await expect(reloadedAssistantMessage).toContainText('42.5 tok/s');
        await expect(reloadedAssistantMessage).toContainText('$0.0004');
        await expect(reloadedAssistantMessage).toContainText('(6 in / 1 out)');
      },
    },
    {
      action: 'Submit a chat message which requires the agent use a tool',
      expectedOutcome:
        'The agents messages will show up in chronological order rather than grouped by type',
      tag: [TAGS.Smoke],
      test: async ({ page }, testInfo) => {
        // Configure defaults for checking later
        const defaultProvider = 'openai';
        const defaultModel = 'gpt-4o-mini';
        const message = 'What is the status of order 12345?';
        const preambleText = 'Let me check on that for you.';
        const toolName = 'lookup_order_status';
        const toolInputs = { orderId: '12345' };
        const toolOutputs = { status: 'shipped', eta: '2026-08-21' };
        const followUpText = 'Your order 12345 has shipped and should arrive by 2026-08-21.';

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

          // Same pacing rationale as the "Send a chat message" step above —
          // gives the loading state a moment to actually render.
          await new Promise((resolve) => setTimeout(resolve, 300));

          const events = [
            // 1. A paragraph of text in the flavor of "let me check on this for you"
            // (trailing blank line so the Markdown renderer splits this from
            // the follow-up into two separate <p> tags)
            { type: 'text_delta', messageId: 'mock-msg-1', delta: `${preambleText}\n\n` },
            // 2. A fake tool call initiation
            {
              type: 'tool_call_start',
              messageId: 'mock-msg-1',
              toolCallId: 'call-1',
              toolName,
              inputs: toolInputs,
            },
            // 3. The fake tool call resolving with some data
            { type: 'tool_call_end', toolCallId: 'call-1', outputs: toolOutputs },
            // 4. A response paragraph based on the fake tool call data
            { type: 'text_delta', messageId: 'mock-msg-1', delta: followUpText },
            {
              type: 'usage_stats',
              messageId: 'mock-msg-1',
              inputTokens: 24,
              outputTokens: 18,
              tokensPerSecond: 35,
              estimatedCostUsd: 0.0009,
            },
            { type: 'stream_done', durationMs: 950, assistantSeq: 2, userSeq: 1 },
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
        await pauseForVideo(page, ChatInterface, testInfo);
        await page.getByRole('button', { name: 'New conversation' }).click();
        await expect(page).toHaveURL(/\/chat\/[^/]+$/);

        // Focus on the chat input and type in a message
        const chatInput = page.locator('[data-slot="textarea"]');
        await chatInput.click();
        await chatInput.fill(message);

        // Press the send button
        await pauseForVideo(page, ChatInterface, testInfo);
        const sendButton = page.locator('button[aria-label="Send message"]');
        await sendButton.click();

        // Wait for the API to return a mocked response (based on how LangChain responds over SSE)
        // which includes:
        // 1. A paragraph of text in the flavor of "let me check on this for you"
        // 2. A fake tool call initiation
        // 3. The fake tool call resolving with some data
        // 4. A response paragraph based on the fake tool call data
        //
        // A tool call mid-turn now renders as two separate assistant
        // bubbles (text before, text after) sandwiching the tool call, so
        // [data-testid="assistant-message"] matches two elements here —
        // .last() is the one carrying the final response, metrics, and
        // seq/fork eligibility (see use-thread.ts's text_delta handler).
        const finalAssistantMessage = page.locator('[data-testid="assistant-message"]').last();
        const toolCallCode = page.locator('code', { hasText: toolName });
        await expect(toolCallCode).toBeVisible();
        await expect(finalAssistantMessage).toContainText(followUpText, { timeout: 10_000 });

        // Verify that the Agent Response has each section and they are ordered as Text, Tool Call, Text
        await pauseForVideo(page, ChatInterface, testInfo);
        const preambleParagraph = page.locator('[data-testid="assistant-message"] .prose p', {
          hasText: preambleText,
        });
        const followUpParagraph = page.locator('[data-testid="assistant-message"] .prose p', {
          hasText: followUpText,
        });
        const preambleY = await topY(preambleParagraph);
        const toolCallY = await topY(toolCallCode);
        const followUpY = await topY(followUpParagraph);
        expect(preambleY, 'The initial text should render above the tool call').toBeLessThan(
          toolCallY,
        );
        expect(toolCallY, 'The tool call should render above the follow-up text').toBeLessThan(
          followUpY,
        );

        // Verify that the metrics and action buttons show up correctly below the Agent response chat message
        await pauseForVideo(page, ChatInterface, testInfo);
        await expect(finalAssistantMessage).toContainText('tok/s');
        await expect(
          finalAssistantMessage.locator('button[aria-label="Fork conversation"]'),
        ).toBeVisible();
      },
    },
  ],
};

suiteRunner(ChatInterface);
