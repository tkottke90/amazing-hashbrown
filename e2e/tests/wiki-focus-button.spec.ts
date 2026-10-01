import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 48,
  name: 'Wiki Focus Button',
  description:
    'Verifies the Document view\'s "Focus Wiki" button starts a fresh wiki chat thread and sends the canned orientation prompt for the selected domain',
  purpose:
    'Orienting the agent to a wiki previously required typing a freeform prompt; this button makes it a one-click action from the view where a user is already looking at that domain, so this guards the button actually drives the same thread-reset + send flow',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke', '@user-workflow'],
      action:
        'From the wiki Document view with a domain selected, click Focus Wiki, with the wiki chat response staged (via a mocked SSE stream) to include a wiki_oriented event',
      expectedOutcome:
        'The canned "Orient to the <domain> wiki." prompt appears as a sent user message, and once the mocked orientation event arrives, both the chat header\'s orientation badge and the Focus Wiki button itself reflect that the domain is now oriented',
      test: () => {},
    },
  ],
};

const DOMAIN = { id: 'homelab', domain: 'infrastructure', tags: [] };

function buildOrientSseBody(): string {
  const events = [
    { type: 'wiki_oriented', wikiId: DOMAIN.id, wikiName: DOMAIN.id },
    { type: 'text_delta', messageId: 'm1', delta: `Oriented to the ${DOMAIN.id} wiki.` },
    { type: 'stream_done', durationMs: 10 },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function mockWikiDocumentView(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    await route.fulfill({ json: [DOMAIN] });
  });
  await page.route('**/api/v1/wiki/graph', async (route: Route) => {
    await route.fulfill({ json: { nodes: [], edges: [] } });
  });
  await page.route('**/api/v1/wiki/domains/*/pages', async (route: Route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/v1/wiki/chat/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() !== 'POST' ||
      !/\/api\/v1\/wiki\/chat\/[^/]+$/.test(url.pathname)
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildOrientSseBody(),
    });
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('clicking Focus Wiki sends the canned orientation prompt and reflects orientation once it lands', async ({
      page,
    }, testInfo) => {
      await mockWikiDocumentView(page);
      await page.goto('/wiki?view=document');

      // Matches the literal `bg-sidebar-accent` class token only — the
      // inactive-but-enabled button also carries `hover:bg-sidebar-accent`,
      // which a plain substring regex would incorrectly match too.
      const activeClass = /(^|\s)bg-sidebar-accent(\s|$)/;

      const focusButton = page.getByRole('button', { name: 'Focus Wiki' });
      await expect(focusButton).toBeEnabled();
      await expect(focusButton).not.toHaveClass(activeClass);

      await pauseBeforeAction(page, testInfo);
      await focusButton.click();

      await expect(page.getByText(`Orient to the ${DOMAIN.id} wiki.`)).toBeVisible();
      await expect(page.getByTestId('wiki-orientation-badge')).toHaveText(DOMAIN.id);
      await expect(focusButton).toHaveClass(activeClass);
    });
  },
);
