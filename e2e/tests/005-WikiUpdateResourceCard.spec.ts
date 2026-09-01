import { expect, type Route } from '@playwright/test';
import { TAGS, TestSuite, suiteRunner, pauseForVideo } from '@tkottke90/playwrite-test-runner';

// Verifies the wiki_update card (see
// docs/superpowers/specs/2026-09-01-wiki-update-resource-card-design.md)
// renders correctly and its Open link navigates to the right wiki document.
// Uses the "mock hydration, not the live turn" pattern (see e2e/AGENTS.md),
// same as 004-CreateWorkspaceSkillCard.spec.ts — a thread whose last
// persisted message is already a wiki_update row is loaded directly, rather
// than driving a full mocked SSE conversation through the wiki write tools.
// This decouples "does the persisted card render and navigate correctly"
// (what this suite checks) from "does the live chat turn produce one"
// (covered by wiki-create-page.tool.test.ts / wiki-update-page.tool.test.ts /
// after-agent.test.ts for the emission/persistence side).
const THREAD_ID = 'thread-wiki-update-card-test';
const DOMAIN_ID = 'homelab';
const PAGE_PATH = 'entities/router.md';

const mockThread = {
  id: THREAD_ID,
  title: 'Wiki Update Card Test',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

const wikiUpdateMessage = {
  id: 'msg-wiki-update-1',
  kind: 'wiki_update',
  seq: 2,
  pageTitle: 'Router',
  pageKind: 'created',
  wikiName: DOMAIN_ID,
  path: PAGE_PATH,
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
      await route.fulfill({ json: { ...mockThread, messages: [wikiUpdateMessage] } });
      return;
    }

    await route.fallback();
  });

  // Destination-page data fetches — the /wiki page's on-mount effects and
  // the document view's own load, so the Open link's target renders with
  // deterministic content rather than a real backend record.
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{ id: DOMAIN_ID, domain: 'Homelab', tags: [] }] });
      return;
    }
    await route.fallback();
  });

  await page.route('**/api/v1/wiki/graph', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { nodes: [], edges: [] } });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/v1/wiki/domains/${DOMAIN_ID}/pages`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: [{ filename: PAGE_PATH, title: 'Router', type: 'entity', tags: [] }],
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/v1/wiki/domains/${DOMAIN_ID}/pages/${PAGE_PATH}`,
    async (route: Route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: {
            filename: PAGE_PATH,
            title: 'Router',
            type: 'entity',
            frontmatter: {},
            content: 'A router at home.',
          },
        });
        return;
      }
      await route.fallback();
    },
  );
}

export const WikiUpdateResourceCard: TestSuite = {
  id: 20,
  name: 'Wiki Update Notification — Resource Card',
  purpose:
    'Verify the wiki_update card renders its badge/title content correctly and its Open link navigates to the right wiki document view, using a hydrated (pre-persisted) message rather than a live model turn.',
  tag: [TAGS.UserWorkflow],
  steps: [
    {
      tag: [TAGS.Smoke],
      action: 'Load a thread whose last message is a persisted wiki_update row',
      expectedOutcome:
        'The card renders the wiki-name badge, a "Created" badge, and the page title, with an Open control',
      test: async ({ page }, testInfo) => {
        await mockApis(page);
        await page.goto('/');

        const row = page
          .locator('[data-slot="thread-row"]')
          .filter({ hasText: 'Wiki Update Card Test' });
        await pauseForVideo(page, WikiUpdateResourceCard, testInfo);
        await row.click();

        const card = page.getByTestId('wiki-update-card');
        await expect(card).toBeVisible({ timeout: 10_000 });
        await expect(card).toContainText(DOMAIN_ID);
        await expect(card).toContainText('Created');
        await expect(card).toContainText('Router');
      },
    },
    {
      action: "Click the wiki_update card's Open link",
      expectedOutcome:
        "The app navigates to the wiki document view for the card's page, which then renders that page's content",
      test: async ({ page }, testInfo) => {
        await pauseForVideo(page, WikiUpdateResourceCard, testInfo);
        await page.getByTestId('wiki-update-open-link').click();

        await page.waitForURL(/\/wiki\?view=document&domain=homelab&page=entities%2Frouter\.md/);
        await expect(page.getByText('Router', { exact: true }).first()).toBeVisible({
          timeout: 10_000,
        });
      },
    },
  ],
};

suiteRunner(WikiUpdateResourceCard);
