import { expect, type Page, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

// Verifies the wake-up card an agent's schedule_wakeup leaves in a chat
// (issue #191, docs/superpowers/specs/2026-09-27-agent-wait-design.md §7):
// it shows what the agent will check and when, and its Trigger now / Cancel
// actions update it. Uses "mock hydration, not the live turn" (see
// e2e/AGENTS.md) — getting a real agent to schedule a wake-up needs a model;
// scheduling itself is covered by the agent-wait eval suite and the API's
// schedule-wakeup.tool.test.ts / threads.route.test.ts.
const TRIGGER_THREAD = 'thread-wakeup-trigger-test';
const CANCEL_THREAD = 'thread-wakeup-cancel-test';

function mockThread(id: string, title: string) {
  return {
    id,
    title,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:01:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    type: 'chat',
    activeTurn: false,
    afterAgentState: { status: 'idle' },
    links: {
      self: `/api/v1/threads/${id}`,
      afterAgentStatus: `/api/v1/threads/${id}/after-agent-status`,
    },
  };
}

function pendingCard(threadId: string) {
  return {
    id: `wakeup-${threadId}`,
    kind: 'wakeup',
    seq: 2,
    wakeupId: `wakeup-${threadId}`,
    note: 'Run kubectl rollout status deploy/api and report whether it succeeded',
    // Always ~15 minutes out, whenever the suite runs.
    fireAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    state: 'pending',
  };
}

async function mockApis(page: Page) {
  const threads = [
    mockThread(TRIGGER_THREAD, 'Deploy wake-up (trigger)'),
    mockThread(CANCEL_THREAD, 'Deploy wake-up (cancel)'),
  ];

  await page.route('**/api/v1/threads**', async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    const action = url.pathname.match(
      /^\/api\/v1\/threads\/([^/]+)\/wakeups\/([^/]+)\/(cancel|trigger)$/,
    );
    if (action && method === 'POST') {
      const [, threadId, , verb] = action;
      const card = pendingCard(threadId!);
      await route.fulfill({
        json:
          verb === 'cancel'
            ? {
                ...card,
                state: 'cancelled',
                settledBy: 'user_cancel',
                settledAt: new Date().toISOString(),
              }
            : {
                ...card,
                state: 'fired',
                settledBy: 'trigger_now',
                settledAt: new Date().toISOString(),
              },
      });
      return;
    }

    const match = url.pathname.match(/^\/api\/v1\/threads(?:\/([^/]+))?$/);
    if (!match) {
      await route.fallback();
      return;
    }
    const id = match[1];
    if (!id && method === 'GET') {
      await route.fulfill({ json: threads });
      return;
    }
    const thread = threads.find((t) => t.id === id);
    if (thread && method === 'GET') {
      const userMessage = {
        id: `user-${id}`,
        kind: 'user',
        seq: 1,
        content: 'The api deploy just started — check back once it has rolled out.',
        sentAt: '2026-09-27T10:00:00.000Z',
      };
      await route.fulfill({ json: { ...thread, messages: [userMessage, pendingCard(id!)] } });
      return;
    }
    await route.fallback();
  });
}

async function openThread(page: Page, title: string) {
  await page.locator('[data-slot="thread-row"]').filter({ hasText: title }).click();
}

export const AgentWakeupCard: TestSuite = {
  id: 42,
  name: 'Agent Wake-up Card',
  purpose:
    'When the agent pauses to wait for something (a deploy, CI), the user can see what it will check and when, and can make it check now or call it off — instead of a hidden timer or a shell sleep that looks like a failure.',
  tag: [TAGS.UserWorkflow],
  steps: [
    {
      tag: [TAGS.Smoke],
      action: 'Open a chat whose agent has scheduled a wake-up',
      expectedOutcome:
        "The wake-up card shows the agent's note, that it fires in about 15 minutes, and Trigger now / Cancel buttons",
      test: async ({ page }, testInfo) => {
        await mockApis(page);
        await page.goto('/');
        await pauseForVideo(page, AgentWakeupCard, testInfo);
        await openThread(page, 'Deploy wake-up (trigger)');

        const card = page.getByTestId('wakeup-card');
        await expect(card).toBeVisible({ timeout: 10_000 });
        await expect(card).toContainText('Run kubectl rollout status deploy/api');
        await expect(page.getByTestId('wakeup-card-status')).toContainText(/in 1[45]m/);
        await expect(page.getByTestId('wakeup-card-trigger')).toBeVisible();
        await expect(page.getByTestId('wakeup-card-cancel')).toBeVisible();
      },
    },
    {
      action: 'Click Trigger now on the wake-up card',
      expectedOutcome: 'The card shows it fired, triggered by the user, and its buttons are gone',
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, AgentWakeupCard, testInfo);
        await page.getByTestId('wakeup-card-trigger').click();

        await expect(page.getByTestId('wakeup-card')).toHaveAttribute('data-state', 'fired');
        await expect(page.getByTestId('wakeup-card-status')).toContainText('triggered by you');
        await expect(page.getByTestId('wakeup-card-trigger')).toHaveCount(0);
      },
    },
    {
      action: "Open another chat with a pending wake-up and click the card's Cancel",
      expectedOutcome: 'The card shows it was cancelled by the user',
      test: async ({ page }, testInfo) => {
        await openThread(page, 'Deploy wake-up (cancel)');
        await expect(page.getByTestId('wakeup-card')).toHaveAttribute('data-state', 'pending');
        await pauseForVideo(page, AgentWakeupCard, testInfo);
        await page.getByTestId('wakeup-card-cancel').click();

        await expect(page.getByTestId('wakeup-card')).toHaveAttribute('data-state', 'cancelled');
        await expect(page.getByTestId('wakeup-card-status')).toHaveText('Cancelled by you');
      },
    },
  ],
};

suiteRunner(AgentWakeupCard);
