import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 23,
  name: 'Chat Scroll Force-to-Bottom',
  description:
    'Verifies that submitting a chat message forces the message pane to the bottom regardless of prior scroll position, and that it keeps following a streamed reply — regression coverage for issue #128',
  purpose:
    'Reading old messages should never cause a newly sent message or its reply to be silently scrolled out of view',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Scroll up into a long thread history, then send a new message',
      expectedOutcome: 'The message pane snaps back to the bottom regardless of prior scroll position',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Let the mocked streamed reply arrive',
      expectedOutcome: 'The pane keeps following the reply and settles at the bottom once it completes',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Scroll away once the reply has finished',
      expectedOutcome: 'The pane stays where the user scrolled it, rather than jumping back down on its own',
      test: () => {},
    },
  ],
};

const THREAD_ID = 'thread-scroll-test';

const mockThread = {
  id: THREAD_ID,
  title: 'Scroll Test',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

// Enough prior turns, each long enough, to overflow the default viewport —
// so the thread loads scrolled well below the top, and scrolling up to read
// it means the bottom sentinel is genuinely out of view.
const HISTORY_TURNS = 14;
const PAD =
  'This line of chat history exists only to give the thread enough height to overflow the viewport. ';

function buildHistoryMessages(): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; i < HISTORY_TURNS; i++) {
    const seq = i * 2 + 1;
    const sentAt = new Date(2026, 8, 5, 10, 0, i).toISOString();
    messages.push({
      kind: 'user',
      id: `hist-user-${seq}`,
      content: `${PAD}(history question ${seq})`,
      sentAt,
      seq,
    });
    messages.push({
      kind: 'assistant',
      id: `hist-assistant-${seq + 1}`,
      status: 'done',
      content: `${PAD}${PAD}(history answer ${seq + 1})`,
      sentAt,
      seq: seq + 1,
    });
  }
  return messages;
}

const NEW_MESSAGE = 'New message sent while scrolled up';
const REPLY_TEXT = 'Here is a streamed reply that arrives after the new message is sent.';

function buildSseBody(): string {
  const events = [
    { type: 'text_delta', messageId: 'reply-1', delta: REPLY_TEXT.slice(0, 20) },
    { type: 'text_delta', messageId: 'reply-1', delta: REPLY_TEXT.slice(20) },
    { type: 'stream_done', durationMs: 10 },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function mockApis(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/v1/threads**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const match = url.pathname.match(/^\/api\/v1\/threads(?:\/([^/]+))?$/);

    if (!match) {
      await route.fallback();
      return;
    }

    const id = match[1];

    if (!id && method === 'GET') {
      await route.fulfill({ json: [mockThread] });
      return;
    }

    if (id === THREAD_ID && method === 'GET') {
      await route.fulfill({
        json: { ...mockThread, messages: buildHistoryMessages() },
      });
      return;
    }

    await route.fallback();
  });

  await page.route(`**/api/v1/chat/${THREAD_ID}`, async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody(),
      });
      return;
    }
    await route.fallback();
  });
}

function distanceFromBottom(el: Element): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('submitting a message force-scrolls to the bottom and keeps following the streamed reply', async ({
      page,
    }, testInfo) => {
      await mockApis(page);
      await page.goto('/');

      const row = page.locator('[data-slot="thread-row"]').filter({ hasText: 'Scroll Test' });
      await row.click();

      const scrollContainer = page.locator('[data-testid="chat-scroll-container"]');
      await expect(scrollContainer).toBeVisible();

      // Scroll up to read history, away from the bottom
      await scrollContainer.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(scrollContainer).toHaveJSProperty('scrollTop', 0);

      await page.locator('[data-slot="textarea"]').fill(NEW_MESSAGE);
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Send message' }).click();

      const userBubble = page.locator('[data-slot="chat-message"]').filter({ hasText: NEW_MESSAGE });
      await expect(userBubble).toBeVisible();

      // Force-scroll on submit, then keep following as the mocked reply
      // streams in — both collapse into "settles near the bottom", since the
      // mocked SSE body arrives as a single fulfilled response rather than
      // real staggered frames.
      await expect
        .poll(() => scrollContainer.evaluate(distanceFromBottom), { timeout: 5_000 })
        .toBeLessThan(40);

      const assistantMsg = page.locator('[data-testid="assistant-message"]').filter({
        hasText: REPLY_TEXT,
      });
      await expect(assistantMsg).toBeVisible({ timeout: 5_000 });
      await expect
        .poll(() => scrollContainer.evaluate(distanceFromBottom), { timeout: 5_000 })
        .toBeLessThan(40);

      // Once the reply has settled, scrolling away should stick — nothing
      // should pull the view back down on its own.
      await scrollContainer.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(scrollContainer).toHaveJSProperty('scrollTop', 0);
      await page.waitForTimeout(500);
      await expect(scrollContainer).toHaveJSProperty('scrollTop', 0);
    });
  },
);
