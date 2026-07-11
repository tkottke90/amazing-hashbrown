import { test, expect } from '@playwright/test';

const suite = {
  id: 5,
  name: 'Chat Send',
  description:
    'Verifies sending a message, receiving a streamed response, stopping generation, and copying a message',
  purpose: 'Ensure the core chat flow works end-to-end against a live LLM',
  tags: ['@user-workflow', '@llm'],
  steps: [
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Type a message and click Send',
      expectedOutcome: 'User message bubble appears immediately (optimistic update)',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Wait for the assistant to respond',
      expectedOutcome: 'Assistant message bubble appears and streaming completes',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Send a long prompt and click Stop while streaming',
      expectedOutcome: 'Streaming halts and the send button is restored',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Click the copy button on a user message',
      expectedOutcome: 'The message text is written to the clipboard',
      test: () => {},
    },
  ],
};

test.describe(
  '@user-workflow @llm',
  {
    annotation: [
      { type: 'suite.id', description: String(suite.id) },
      { type: 'suite.name', description: suite.name },
      { type: 'suite.description', description: suite.description },
      { type: 'suite.purpose', description: suite.purpose },
    ],
  },
  () => {
    test('user message bubble appears immediately after send', async ({ page }) => {
      await page.goto('/');

      const message = 'Hello from Playwright';
      await page.locator('[data-slot="textarea"]').fill(message);
      await page.locator('button[aria-label="Send message"]').click();

      const userBubble = page.locator('[data-slot="chat-message"][data-mirrored]');
      await expect(userBubble).toBeVisible();
      await expect(userBubble.locator('[data-slot="chat-message-body"]')).toContainText(message);
    });

    test('assistant response appears after send', async ({ page }) => {
      await page.goto('/');

      await page.locator('[data-slot="textarea"]').fill('Say exactly: pong');
      await page.locator('button[aria-label="Send message"]').click();

      const assistantMsg = page.locator('[data-testid="assistant-message"]');
      await expect(assistantMsg).toBeVisible({ timeout: 30_000 });
      // Streaming complete when the loading dots are gone
      await expect(assistantMsg.locator('.animate-bounce').first()).not.toBeVisible({
        timeout: 30_000,
      });
    });

    test('stop generation halts streaming and restores send button', async ({ page }) => {
      test.slow();
      await page.goto('/');

      await page
        .locator('[data-slot="textarea"]')
        .fill('Write a 5000-word essay about the entire history of computer science');
      await page.locator('button[aria-label="Send message"]').click();

      const stopBtn = page.locator('button[aria-label="Stop generating"]');
      await expect(stopBtn).toBeVisible({ timeout: 15_000 });

      await stopBtn.click();

      await expect(page.locator('button[aria-label="Send message"]')).toBeVisible({
        timeout: 5_000,
      });
    });

    test('copy button writes user message to clipboard', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/');

      const message = 'Copy this text please';
      await page.locator('[data-slot="textarea"]').fill(message);
      await page.locator('button[aria-label="Send message"]').click();

      const userBubble = page.locator('[data-slot="chat-message"][data-mirrored]');
      await expect(userBubble).toBeVisible();

      const copyBtn = userBubble.locator('button[aria-label="Copy to clipboard"]');
      await expect(copyBtn).toBeVisible();
      await copyBtn.click();

      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(message);
    });
  },
);
