import { test, expect } from '@playwright/test';

const suite = {
  id: 6,
  name: 'HITL Prompts',
  description: 'Verifies human-in-the-loop prompts disable the chat input and resume it after answering',
  purpose: 'Ensure the agent can pause for user input and the UI correctly reflects the pending state',
  tags: ['@user-workflow', '@llm'],
  steps: [
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Trigger a yes/no HITL prompt and click Yes',
      expectedOutcome: 'Textarea is disabled while pending; re-enabled after answering',
      test: () => {},
    },
    {
      tags: ['@user-workflow', '@llm'],
      action: 'Trigger a free-text HITL prompt, type an answer, and submit',
      expectedOutcome: 'Textarea is disabled while pending; re-enabled after submitting',
      test: () => {},
    },
  ],
};

void suite;

test.describe('@user-workflow @llm', () => {
  test('HITL yes/no: pending prompt disables textarea; Yes re-enables it', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-slot="textarea"]').fill(
      'Ask me a yes or no question before you do anything',
    );
    await page.locator('button[aria-label="Send message"]').click();

    const textarea = page.locator('[data-slot="textarea"]');
    await expect(textarea).toBeDisabled({ timeout: 30_000 });

    const yesButton = page.locator('button', { hasText: 'Yes' });
    const noButton = page.locator('button', { hasText: 'No' });
    await expect(yesButton).toBeVisible();
    await expect(noButton).toBeVisible();

    await yesButton.click();
    await expect(textarea).toBeEnabled({ timeout: 10_000 });
  });

  test('HITL free-text: inline input accepts answer and re-enables textarea', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-slot="textarea"]').fill(
      'Ask me an open-ended question and wait for my text response',
    );
    await page.locator('button[aria-label="Send message"]').click();

    const textarea = page.locator('[data-slot="textarea"]');
    await expect(textarea).toBeDisabled({ timeout: 30_000 });

    const hitlInput = page.locator('input[placeholder="Type your answer…"]');
    await expect(hitlInput).toBeVisible();
    await hitlInput.fill('My detailed answer here');

    await page.locator('button[type="submit"]', { hasText: 'Submit' }).click();
    await expect(textarea).toBeEnabled({ timeout: 10_000 });
  });
});
