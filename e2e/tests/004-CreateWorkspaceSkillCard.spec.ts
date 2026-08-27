import { expect, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

// Verifies the resource card produced by /create-workspace and
// /create-project (see docs/superpowers/specs/2026-08-26-chat-workspace-project-creation-skills-design.md)
// renders correctly and its Open link navigates to the resource's detail
// page. Uses the "mock hydration, not the live turn" pattern (see
// e2e/AGENTS.md) — a thread whose last persisted message is already a
// resource_card is loaded directly, rather than driving a full mocked SSE
// conversation through the skill's field-collection flow. This decouples
// "does the persisted card render and navigate correctly" (what this suite
// checks) from "does the live chat turn produce one" (covered by the
// create-workspace-project eval suite for the model-behavior side, and by
// stream-handler.test.ts / thread-message-writer.test.ts for the
// persistence side).
const THREAD_ID = 'thread-resource-card-test';
const WORKSPACE_ID = 'ws-resource-card-test';

const mockThread = {
  id: THREAD_ID,
  title: 'Resource Card Test',
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

const resourceCardMessage = {
  id: 'msg-resource-card-1',
  kind: 'resource_card',
  seq: 2,
  resourceType: 'workspace',
  name: 'Homelab Ops',
  goal: 'Track and automate home server maintenance',
  location: '/tmp/projects/homelab-ops',
  workspaceId: WORKSPACE_ID,
};

async function mockApis(page: import('@playwright/test').Page) {
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
      await route.fulfill({ json: { ...mockThread, messages: [resourceCardMessage] } });
      return;
    }

    await route.fallback();
  });

  // The Open link navigates to /workspaces/:id — stub the workspace detail
  // fetch so the destination page itself renders without a real backend
  // record for this fixture's workspace id.
  await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          id: WORKSPACE_ID,
          name: 'Homelab Ops',
          description: null,
          goal: 'Track and automate home server maintenance',
          location: '/tmp/projects/homelab-ops',
          remoteUrl: null,
          javascript: false,
          python: false,
          git: false,
          wikiId: null,
          systemPrompt: null,
          threadId: null,
          summaryPath: null,
          lastSummarizedMessageId: null,
          createdAt: '2026-08-26T10:00:00.000Z',
          updatedAt: '2026-08-26T10:00:00.000Z',
          lastChange: '2026-08-26T10:00:00.000Z',
        },
      });
      return;
    }
    await route.fallback();
  });
}

export const CreateWorkspaceSkillCard: TestSuite = {
  id: 19,
  name: 'Create Workspace Skill — Resource Card',
  purpose:
    'Verify the resource card produced by /create-workspace and /create-project renders its content correctly and its Open link navigates to the resource detail page, using a hydrated (pre-persisted) message rather than a live model turn.',
  tag: [TAGS.UserWorkflow],
  steps: [
    {
      tag: [TAGS.Smoke],
      action: 'Load a thread whose last message is a persisted resource_card',
      expectedOutcome:
        'The card renders a Workspace badge, the resource name, the goal snippet, and the location, with an Open control',
      test: async ({ page }, testInfo) => {
        await mockApis(page);
        await page.goto('/');

        const row = page
          .locator('[data-slot="thread-row"]')
          .filter({ hasText: 'Resource Card Test' });
        await pauseForVideo(page, CreateWorkspaceSkillCard, testInfo);
        await row.click();

        const card = page.getByTestId('resource-card');
        await expect(card).toBeVisible({ timeout: 10_000 });
        await expect(card).toContainText('Workspace');
        await expect(card).toContainText('Homelab Ops');
        await expect(card).toContainText('Track and automate home server maintenance');
        await expect(card).toContainText('/tmp/projects/homelab-ops');
      },
    },
    {
      action: "Click the resource card's Open link",
      expectedOutcome: "The app navigates to /workspaces/:id for the card's resource",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, CreateWorkspaceSkillCard, testInfo);
        await page.getByTestId('resource-card-open-link').click();

        await page.waitForURL(new RegExp(`/workspaces/${WORKSPACE_ID}$`));
      },
    },
  ],
};

suiteRunner(CreateWorkspaceSkillCard);
