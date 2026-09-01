import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 22,
  name: 'Chat Message Ordering',
  description:
    'Verifies tool calls render inline, in the order they actually occurred, rather than after the assistant’s full response text — regression coverage for issue #65',
  purpose:
    'A turn with text → tool call → text must render as three chronologically ordered items, not text-then-tool-calls, so the user can follow what happened when',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        'Send a wiki chat message whose response is staged (via a mocked SSE stream) as text, then a tool call, then more text',
      expectedOutcome:
        'The three items render in the DOM in that exact order: first text bubble, then the tool call card, then the second text bubble',
      test: () => {},
    },
  ],
};

// A hand-built SSE response body — per e2e/AGENTS.md, a static
// `data: {...}\n\n` string fulfills exactly like a real (if instant) stream
// to the client's parser. This stages the precise interleaving issue #65
// reported, without needing a live LLM to reliably reproduce a tool call
// mid-response.
const FIRST_TEXT = 'Let me check the weather.';
const SECOND_TEXT = 'Today the weather is sunny with a 10% chance of rain.';

function buildSseBody(): string {
  const events = [
    { type: 'text_delta', messageId: 'm1', delta: FIRST_TEXT },
    {
      type: 'tool_call_start',
      messageId: 'tc-evt',
      toolCallId: 'tc1',
      toolName: 'get_weather',
      inputs: {},
    },
    { type: 'tool_call_end', toolCallId: 'tc1', outputs: 'Sunny, 72F' },
    { type: 'text_delta', messageId: 'm1', delta: SECOND_TEXT },
    { type: 'stream_done', durationMs: 42 },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function mockWikiChatTurn(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/v1/wiki/graph', async (route: Route) => {
    await route.fulfill({ json: { nodes: [], edges: [] } });
  });
  await page.route('**/api/v1/wiki/chat/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() !== 'POST' ||
      !/\/api\/v1\/wiki\/chat\/[^/]+$/.test(url.pathname)
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody(),
    });
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('a mid-turn tool call renders between the text that preceded and followed it', async ({
      page,
    }, testInfo) => {
      await mockWikiChatTurn(page);
      await page.goto('/wiki');

      await page.locator('[data-slot="textarea"]').fill('What is the weather like?');
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Send message' }).click();

      // Any element identifying a chat row, in DOM (i.e. chronological
      // render) order — a CSS selector list matches in document order.
      const rows = page.locator(
        '[data-slot="chat-message"], [data-testid="assistant-message"], [data-testid="tool-call-message"]',
      );
      await expect(rows).toHaveCount(4, { timeout: 15_000 });

      await expect(rows.nth(0)).toHaveAttribute('data-slot', 'chat-message');
      await expect(rows.nth(0)).toContainText('What is the weather like?');

      await expect(rows.nth(1)).toHaveAttribute('data-testid', 'assistant-message');
      await expect(rows.nth(1)).toContainText(FIRST_TEXT);
      await expect(rows.nth(1)).not.toContainText(SECOND_TEXT);

      await expect(rows.nth(2)).toHaveAttribute('data-testid', 'tool-call-message');
      await expect(rows.nth(2)).toContainText('get_weather');

      await expect(rows.nth(3)).toHaveAttribute('data-testid', 'assistant-message');
      await expect(rows.nth(3)).toContainText(SECOND_TEXT);
      await expect(rows.nth(3)).not.toContainText(FIRST_TEXT);
    });
  },
);
