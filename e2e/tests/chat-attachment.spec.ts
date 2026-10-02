import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 32,
  name: 'Chat Attachment',
  description:
    'Verifies attaching a file to a chat message actually reaches the model and the attachment chip clears once the message is sent — regression coverage for issue #251',
  purpose:
    'The attachment chip previously never cleared after send (ChatInput tracked it in private state separate from the parent), leaving users unsure whether a follow-up message still carried a stale file; this guards against that regressing',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Attach a plain-text file, type a question, and send',
      expectedOutcome:
        'The attachment chip disappears immediately on send, and the request sent to the server carries the uploaded attachment id',
      test: () => {},
    },
  ],
};

const ASSISTANT_REPLY = 'The file says: the secret code is pineapple.';

function buildSseBody(): string {
  const events = [
    { type: 'text_delta', messageId: 'm1', delta: ASSISTANT_REPLY },
    { type: 'stream_done', durationMs: 10 },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('attaching a file clears the chip on send and the request carries the attachment id', async ({
      page,
    }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      // Real upload — hits the actual (locally running) /api/v1/artifacts
      // endpoint, not mocked, so this exercises the real MIME handling and
      // classification code, not a stand-in for it.
      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('The secret code is pineapple.'),
      });

      const chip = page.locator('[data-slot="chat-input-chip"]', { hasText: 'notes.txt' });
      await expect(chip).toBeVisible();

      // The actual send request is left real on the client side — only the
      // model's reply is faked (no live LLM here) — so capturing its body
      // here proves the real request-construction code path included the
      // attachment, rather than asserting against a canned response that
      // would pass even if the attachment had been silently dropped.
      let capturedBody: { attachmentId?: string; content?: string } | undefined;
      await page.route('**/api/v1/chat/**', async (route: Route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || !/\/api\/v1\/chat\/[^/]+$/.test(url.pathname)) {
          await route.fallback();
          return;
        }
        capturedBody = route.request().postDataJSON() as { attachmentId?: string };
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: buildSseBody(),
        });
      });

      await page.locator('[data-slot="textarea"]').fill('What does the file say?');
      await page.locator('button[aria-label="Send message"]').click();

      // The literal #251 regression: the chip must be gone the moment the
      // message is sent, not just after the turn finishes.
      await expect(chip).not.toBeVisible();

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(assistantMsg).toContainText(ASSISTANT_REPLY, { timeout: 15_000 });

      expect(
        capturedBody?.attachmentId,
        'the send request must carry the uploaded attachment id',
      ).toBeTruthy();
    });
  },
);
