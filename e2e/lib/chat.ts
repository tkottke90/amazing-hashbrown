import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Navigates straight to a fresh, not-yet-existing chat thread — the same
 * empty-composer state the old root-route auto-redirect used to produce
 * before `/` became the dashboard. ui/src/hooks/use-thread.ts's hydrate()
 * treats a 404 (thread not found) as "start empty," not an error, so this
 * is equivalent, not a workaround.
 */
export async function gotoNewChat(page: Page): Promise<string> {
  const id = randomUUID();
  await page.goto(`/chat/${id}`);
  return id;
}
