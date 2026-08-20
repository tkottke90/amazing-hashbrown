import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: process.env['CI']
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'on-failure' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'],
    },
  },
  outputDir: 'test-results',

  webServer: [
    {
      // dev:api builds libs then starts the API in watch mode
      command: 'npm run dev:api',
      url: 'http://localhost:3000/api/v1/health',
      cwd: repoRoot,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      // Shortens the chat-pause idle-resume timer (30s in prod/dev — see
      // task-scheduler.ts) so pause/resume e2e tests don't burn 30+ real
      // seconds per assertion. Only takes effect when Playwright actually
      // spawns the server (reuseExistingServer is false, i.e. CI, or no
      // server was already running locally).
      env: { CHAT_IDLE_RESUME_MS: '3000' },
    },
    {
      command: 'npm run dev:ui',
      url: 'http://localhost:5173',
      cwd: repoRoot,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  ],

  projects: [
    {
      // Everything NOT tagged @user-workflow (e.g. @functional health checks) —
      // default asset capture (screenshot only on failure, no video) is enough.
      // Settings specs are excluded here; they run in chromium-settings instead.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: /@user-workflow/,
      testIgnore: ['**/settings-*.spec.ts'],
    },
    {
      // @user-workflow specs simulate a real user completing a task, so a
      // screenshot and a video are captured for every run (pass or fail) —
      // reviewers can see the actual flow, not just debug a failure.
      // Settings specs are excluded here; they run in chromium-settings instead.
      name: 'chromium-user-workflow',
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'on',
        video: 'on',
      },
      grep: /@user-workflow/,
      testIgnore: ['**/settings-*.spec.ts'],
    },
    {
      // All settings specs — both @smoke and @user-workflow — are run here with
      // screenshots and video on every run (pass or fail) so reviewers can see
      // the complete settings UI flow without waiting for a failure to capture.
      name: 'chromium-settings',
      use: {
        ...devices['Desktop Chrome'],
        screenshot: 'on',
        video: 'on',
      },
      testMatch: ['**/settings-*.spec.ts'],
    },
  ],
});
