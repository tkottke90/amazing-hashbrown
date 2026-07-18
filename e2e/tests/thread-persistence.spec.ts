import { test, expect } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';

const suite: TestSuite = {
  id: 8,
  name: 'Thread Persistence',
  description:
    'Verifies a real conversation survives a reload, and that rename/delete/fork/regenerate-title work end-to-end against a live LLM',
  purpose:
    'Ensure conversation history is actually persisted server-side, not just held in browser memory',
  tags: ['@user-workflow', '@llm'],
  steps: [
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Send a message and wait for the assistant to respond',
      expectedOutcome: 'A sidebar entry appears with a title derived from the message',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Reload the page',
      expectedOutcome: 'The same user/assistant messages reappear, rehydrated from the server',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Rename the thread from the sidebar, then reload',
      expectedOutcome: 'The new title persists across reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Delete the active thread',
      expectedOutcome: 'The thread disappears from the sidebar and an empty conversation is shown',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Fork from a completed assistant turn',
      expectedOutcome: 'A new thread is created with the "Forked from" lineage subtitle and copied history',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Click Regenerate title on a thread with messages',
      expectedOutcome: "The sidebar title updates to the model's generated title",
      test: () => {},
    },
  ],
};

async function sendAndAwaitReply(
  page: import('@playwright/test').Page,
  message: string,
): Promise<void> {
  await page.locator('[data-slot="textarea"]').fill(message);
  await page.locator('button[aria-label="Send message"]').click();

  const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
  await expect(assistantMsg).toBeVisible({ timeout: 30_000 });
  await expect(assistantMsg.locator('.animate-bounce').first()).not.toBeVisible({
    timeout: 30_000,
  });
}

test.describe(
  '@user-workflow @llm',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('sending a message creates a sidebar entry with a truncated title', async ({ page }) => {
      await page.goto('/');
      const message = `Persistence check ${Date.now()}`;
      await sendAndAwaitReply(page, message);

      const sidebar = page.locator('aside[aria-label="Sidebar navigation"]');
      await expect(sidebar.getByText(message)).toBeVisible();
    });

    test('reloading the page rehydrates the conversation', async ({ page }) => {
      await page.goto('/');
      const message = `Reload check ${Date.now()}`;
      await sendAndAwaitReply(page, message);

      await page.reload();

      const userBubble = page.locator('[data-slot="chat-message"][data-mirrored]');
      await expect(userBubble).toBeVisible();
      await expect(userBubble.locator('[data-slot="chat-message-body"]')).toContainText(message);
      await expect(page.locator('[data-testid="assistant-message"]')).toBeVisible();
    });

    test('renaming a thread persists across reload', async ({ page }) => {
      await page.goto('/');
      await sendAndAwaitReply(page, `Rename check ${Date.now()}`);

      const newTitle = `Renamed by e2e ${Date.now()}`;
      const activeRow = page.locator('[data-slot="thread-row"][data-active]');
      await activeRow.hover();
      await activeRow.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      // The row's data-slot wrapper is replaced by a plain edit-mode div while
      // renaming, so `activeRow` no longer matches — locate the input at the
      // sidebar level instead (only one row can be editing at a time).
      const input = page.locator('aside[aria-label="Sidebar navigation"] input');
      await input.fill(newTitle);
      await input.press('Enter');

      await expect(
        page.locator('[data-slot="thread-row"]').filter({ hasText: newTitle }),
      ).toBeVisible();

      await page.reload();
      await expect(
        page.locator('[data-slot="thread-row"]').filter({ hasText: newTitle }),
      ).toBeVisible();
    });

    test('deleting the active thread clears the view and removes the sidebar row', async ({
      page,
    }) => {
      await page.goto('/');
      const message = `Delete check ${Date.now()}`;
      await sendAndAwaitReply(page, message);

      const activeRow = page.locator('[data-slot="thread-row"][data-active]');
      await activeRow.hover();
      await activeRow.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('button', { name: 'Confirm delete' }).click();

      await expect(page.locator('aside[aria-label="Sidebar navigation"]').getByText(message)).not.toBeVisible();
      await expect(page.locator('[data-testid="assistant-message"]')).not.toBeVisible();
    });

    test('forking from a completed turn creates a new lineage-linked thread', async ({ page }) => {
      await page.goto('/');
      await sendAndAwaitReply(page, `Fork check ${Date.now()}`);

      const assistantMsg = page.locator('[data-testid="assistant-message"]').last();
      const forkBtn = assistantMsg.locator('button[aria-label="Fork conversation"]');
      await expect(forkBtn).toBeVisible();
      await forkBtn.click();

      const activeRow = page.locator('[data-slot="thread-row"][data-active]');
      await expect(activeRow.getByText(/^Forked from /)).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid="assistant-message"]')).toBeVisible();
    });

    test('regenerating a title updates the sidebar entry', async ({ page }) => {
      await page.goto('/');
      const message = `Regenerate title check ${Date.now()}`;
      await sendAndAwaitReply(page, message);

      const activeRow = page.locator('[data-slot="thread-row"][data-active]');
      await activeRow.hover();
      await activeRow.locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Regenerate title' }).click();

      await expect(activeRow.getByText(message)).not.toBeVisible({ timeout: 30_000 });
    });
  },
);
