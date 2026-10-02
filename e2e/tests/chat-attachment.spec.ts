import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 32,
  name: 'Chat Attachment',
  description:
    'Verifies attaching files to a chat message reaches the model as attachmentIds, each shows as a uniform clickable tile in the sent bubble with its own included/excluded outcome, and the 4-attachment cap is enforced both client- and server-side — regression coverage for issue #251 and the multi-attachment redesign for issue #256',
  purpose:
    'The attachment chip previously never cleared after send (ChatInput tracked it in private state separate from the parent), leaving users unsure whether a follow-up message still carried a stale file; multi-attachment staging and the optimistic-preview-then-patched-outcome flow are new surface area with their own regression risk',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Attach up to 4 files, type a question, and send',
      expectedOutcome:
        'All 4 chips appear in the composer, the request sent to the server carries every uploaded attachment id, and the sent bubble shows one tile per attachment — the one the server marks excluded shows a badge, the others do not',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click an image tile and a non-image tile in a sent message',
      expectedOutcome:
        'The image tile opens a lightbox; the non-image tile opens a download dialog',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'Stage a 5th file after 4 are already staged, and separately send 5 attachmentIds directly to the API',
      expectedOutcome:
        'The 5th file is rejected client-side with a count-naming error; the API independently rejects a request carrying more than 4 attachmentIds with a 400',
      test: () => {},
    },
  ],
};

const ASSISTANT_REPLY = 'Got your files.';

// A 1x1 transparent PNG — small enough to inline, real enough bytes for the
// server's own MIME classification to treat it as an image attachment (not
// just a text one tagged image/png), which is what AttachmentTile needs to
// pick its image branch in the sent bubble.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface MockAttachmentOutcome {
  id: string;
  filename: string;
  mimeType: string;
  included: boolean;
  exclusionReason?: string;
}

function buildSseBody(attachments?: MockAttachmentOutcome[]): string {
  const events = [
    { type: 'text_delta', messageId: 'm1', delta: ASSISTANT_REPLY },
    { type: 'stream_done', durationMs: 10, ...(attachments ? { attachments } : {}) },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('attaching 4 files sends every attachmentId, and the sent bubble shows per-attachment outcomes with working tiles', async ({
      page,
    }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      // Real uploads — hits the actual (locally running) /api/v1/artifacts
      // endpoint for each file, not mocked, exercising the real multi-file
      // staging path. Passed through unmodified; only used here to learn
      // which real artifact id corresponds to the image, so the mocked
      // stream_done below can mark that specific one excluded.
      const uploadedIds = new Map<string, string>();
      await page.route('**/api/v1/artifacts', async (route: Route) => {
        if (route.request().method() !== 'POST') {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as { id: string; displayFilename: string };
        uploadedIds.set(body.displayFilename, body.id);
        await route.fulfill({ response });
      });

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles([
        { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('first file') },
        { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('second file') },
        { name: 'three.txt', mimeType: 'text/plain', buffer: Buffer.from('third file') },
        { name: 'four.png', mimeType: 'image/png', buffer: TINY_PNG },
      ]);

      const chips = page.locator('[data-slot="chat-input-chip"]');
      await expect(chips).toHaveCount(4);
      await expect(
        page.locator('[data-slot="chat-input-chip"]', { hasText: 'four.png' }),
      ).toBeVisible();

      let capturedBody: { attachmentIds?: string[]; content?: string } | undefined;
      await page.route('**/api/v1/chat/**', async (route: Route) => {
        const url = new URL(route.request().url());
        if (route.request().method() !== 'POST' || !/\/api\/v1\/chat\/[^/]+$/.test(url.pathname)) {
          await route.fallback();
          return;
        }
        capturedBody = route.request().postDataJSON() as { attachmentIds?: string[] };
        const imageId = uploadedIds.get('four.png');
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: buildSseBody(
            imageId
              ? [
                  {
                    id: imageId,
                    filename: 'four.png',
                    mimeType: 'image/png',
                    included: false,
                    exclusionReason: 'vision_unsupported',
                  },
                ]
              : undefined,
          ),
        });
      });

      await page.locator('[data-slot="textarea"]').fill('What do these files say?');
      const sendButton = page.locator('button[aria-label="Send message"]');
      // Send is disabled for as long as any upload is still in flight (the
      // #256 fix for the latent race where Send used to fire before an
      // upload resolved) — the chip-count(4) check above can pass on a mix
      // of spinner + real chips, so this is the actual gate that matters.
      await expect(sendButton).toBeEnabled();
      await sendButton.click();

      // The #251 regression: chips must be gone the moment the message is
      // sent, not just after the turn finishes.
      await expect(chips).toHaveCount(0);

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      await expect(assistantMsg).toContainText(ASSISTANT_REPLY, { timeout: 15_000 });

      expect(
        capturedBody?.attachmentIds,
        'the send request must carry every uploaded attachment id',
      ).toHaveLength(4);

      // The sent bubble: one tile per attachment, and exactly the image's
      // tile carries the excluded badge once stream_done's attachments
      // array patches it in — this is the actual fix for #256 (the live
      // SSE stream never used to report this back at all).
      const tiles = page.locator('[data-slot="chat-message-attachment"]');
      await expect(tiles).toHaveCount(4);

      const excludedBadge = page.getByRole('button', { name: /not processed/i });
      await expect(excludedBadge).toHaveCount(1);
      const excludedTile = excludedBadge.locator(
        'xpath=ancestor::div[@data-slot="chat-message-attachment"]',
      );
      const excludedTileButton = excludedTile.locator('button[title]');
      await expect(excludedTileButton).toHaveAttribute('title', 'four.png');

      // Click the image tile — opens a lightbox showing the full image.
      await excludedTileButton.click();
      const dialog = page.locator('dialog[open]');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('img')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // Click a non-image tile — opens a download dialog with a working
      // link instead.
      const textTile = page.locator('[data-slot="chat-message-attachment"]', {
        has: page.locator('button[title="one.txt"]'),
      });
      await textTile.locator('button[title]').click();
      const downloadDialog = page.locator('dialog[open]');
      await expect(downloadDialog).toBeVisible();
      const downloadLink = downloadDialog.getByRole('link', { name: /download/i });
      await expect(downloadLink).toHaveAttribute('download', 'one.txt');
      await expect(downloadLink).toHaveAttribute('href', /\/api\/v1\/artifacts\//);
    });

    test('a 5th staged file is rejected client-side, and the API independently rejects more than 4 attachmentIds', async ({
      page,
      request,
    }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles([
        { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
        { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('2') },
        { name: 'three.txt', mimeType: 'text/plain', buffer: Buffer.from('3') },
        { name: 'four.txt', mimeType: 'text/plain', buffer: Buffer.from('4') },
      ]);
      await expect(page.locator('[data-slot="chat-input-chip"]')).toHaveCount(4);

      // A 5th file, staged after the cap is already full — rejected
      // entirely (0 remaining slots), with an error naming the count.
      await fileInput.setInputFiles([
        { name: 'five.txt', mimeType: 'text/plain', buffer: Buffer.from('5') },
      ]);
      await expect(page.getByText(/only 4 attachments allowed/i)).toBeVisible();
      await expect(page.locator('[data-slot="chat-input-chip"]')).toHaveCount(4);
      await expect(
        page.locator('[data-slot="chat-input-chip"]', { hasText: 'five.txt' }),
      ).toHaveCount(0);

      // Defense-in-depth: the server rejects a request carrying more than 4
      // attachmentIds even bypassing the UI entirely, hitting the real
      // route directly.
      const response = await request.post(`/api/v1/chat/e2e-attachment-cap-${Date.now()}`, {
        data: {
          content: 'hello',
          attachmentIds: ['a', 'b', 'c', 'd', 'e'],
        },
      });
      expect(response.status()).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toMatch(/at most 4/i);
    });
  },
);
