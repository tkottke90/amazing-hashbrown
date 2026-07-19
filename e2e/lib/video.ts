import type { Page, TestInfo } from '@playwright/test';

const RECORDING_PAUSE_MS = 2000;

/**
 * Pauses for RECORDING_PAUSE_MS, but only when the current project is
 * actually recording video — a no-op (and no wasted time) on projects that
 * aren't. Call this right before the action a test exists to verify, after
 * navigation/setup, so a video viewer has a moment to see the "before"
 * state before the change happens.
 */
export async function pauseBeforeAction(page: Page, testInfo: TestInfo): Promise<void> {
  const video = testInfo.project.use.video;
  const mode = typeof video === 'string' ? video : video?.mode;
  if (mode && mode !== 'off') {
    await page.waitForTimeout(RECORDING_PAUSE_MS);
  }
}
