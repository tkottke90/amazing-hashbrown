import { test, expect, type Route, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 62,
  name: 'Markdown Inline SVG Rendering',
  description:
    'Verifies a raw <svg> block in Markdown source renders as real SVG (not escaped text) in both chat bubbles and the wiki page preview, that an embedded <style> stays CSS-scoped to its own SVG via the Shadow DOM SVG Sandbox, and that an oversized SVG is capped to its container width',
  purpose:
    'Jest cannot exercise this at all — the react-markdown mock ignores rehypePlugins/components entirely — so this is the only automated coverage for the real rehype-raw/rehype-sanitize/SVG Sandbox pipeline wired together (issue #425, ADR-0071, ADR-0072)',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Load a chat thread and a wiki page whose content contains a raw <svg> block',
      expectedOutcome:
        'The SVG renders as a real SVGElement inside the SVG Sandbox, in both surfaces, not as escaped text',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'Load a chat thread whose message contains an SVG with an embedded <style> rule, next to an unrelated sibling message',
      expectedOutcome:
        "The style's rule applies inside the SVG's own shadow root but does not leak out to the sibling message",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Load a chat thread whose message contains an oversized SVG (width="2000")',
      expectedOutcome: "The SVG's rendered width is capped to its message container's width",
      test: () => {},
    },
  ],
};

const SAFE_SVG =
  '<svg viewBox="0 0 100 100" data-testid="inline-svg-root"><defs><symbol id="dot"><circle cx="5" cy="5" r="5"/></symbol></defs><use href="#dot" x="10" y="10"/><rect x="0" y="0" width="20" height="20" fill="#000"/></svg>';

const STYLE_SVG =
  '<svg viewBox="0 0 20 20"><style>circle{fill:red}</style><circle cx="10" cy="10" r="8"/></svg>';

const OVERSIZED_SVG = '<svg width="2000" height="2000" viewBox="0 0 2000 2000"><rect x="0" y="0" width="2000" height="2000" fill="#09c"/></svg>';

const THREAD_ID = 'thread-inline-svg-test';

const mockThread = {
  id: THREAD_ID,
  title: 'Inline SVG Test',
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-19T10:01:00.000Z',
  forkedFromThreadId: null,
  forkedFromSeq: null,
  afterAgentState: { status: 'idle' },
  links: {
    self: `/api/v1/threads/${THREAD_ID}`,
    afterAgentStatus: `/api/v1/threads/${THREAD_ID}/after-agent-status`,
  },
};

async function mockChatApis(page: Page, messages: Array<Record<string, unknown>>): Promise<void> {
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
      await route.fulfill({ json: { ...mockThread, messages } });
      return;
    }

    await route.fallback();
  });
}

const WIKI_DOMAIN = { id: 'svg-demo-domain', domain: 'svg-demo-domain', tags: [] };
const WIKI_PAGE_FILENAME = 'svg-demo-page';
const WIKI_PAGE_TITLE = 'SVG Demo Page';

async function mockWikiDocumentView(page: Page, content: string): Promise<void> {
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    await route.fulfill({ json: [WIKI_DOMAIN] });
  });
  await page.route('**/api/v1/wiki/graph', async (route: Route) => {
    await route.fulfill({ json: { nodes: [], edges: [] } });
  });
  await page.route('**/api/v1/wiki/domains/*/pages', async (route: Route) => {
    await route.fulfill({
      json: [{ filename: WIKI_PAGE_FILENAME, title: WIKI_PAGE_TITLE, type: 'concept', tags: [] }],
    });
  });
  await page.route('**/api/v1/wiki/domains/*/pages/*', async (route: Route) => {
    await route.fulfill({
      json: {
        filename: WIKI_PAGE_FILENAME,
        title: WIKI_PAGE_TITLE,
        type: 'concept',
        frontmatter: {},
        content,
      },
    });
  });
}

const svgSandbox = (page: Page) => page.getByTestId('svg-sandbox');

test.describe('@user-workflow', { annotation: suiteAnnotations(suite) }, () => {
  test('renders as a real SVGElement in a chat bubble @user-workflow', async ({ page }, testInfo) => {
    await mockChatApis(page, [
      {
        kind: 'assistant',
        id: 'assistant-1',
        status: 'done',
        content: `Here is a diagram:\n\n${SAFE_SVG}`,
        sentAt: '2026-11-19T10:00:30.000Z',
        seq: 1,
      },
    ]);
    await page.goto(`/chat/${THREAD_ID}`);

    const sandbox = page.getByTestId('assistant-message').locator('[data-testid="svg-sandbox"]');
    await pauseBeforeAction(page, testInfo);
    const svg = sandbox.locator('svg');
    await expect(svg).toBeVisible();
    expect(await svg.evaluate((el) => el instanceof SVGElement)).toBe(true);
    await expect(sandbox.locator('use')).toHaveCount(1);
  });

  test('renders as a real SVGElement in the wiki page preview @user-workflow', async ({ page }, testInfo) => {
    await mockWikiDocumentView(page, `Here is a diagram:\n\n${SAFE_SVG}`);
    await page.goto(`/wiki?view=document&domain=${WIKI_DOMAIN.id}`);

    await page.getByRole('button', { name: WIKI_PAGE_TITLE }).click();

    const sandbox = svgSandbox(page);
    await pauseBeforeAction(page, testInfo);
    const svg = sandbox.locator('svg');
    await expect(svg).toBeVisible();
    expect(await svg.evaluate((el) => el instanceof SVGElement)).toBe(true);
  });

  test("an embedded <style> stays scoped to its own SVG's shadow root @user-workflow", async ({
    page,
  }, testInfo) => {
    await mockChatApis(page, [
      {
        kind: 'assistant',
        id: 'assistant-1',
        status: 'done',
        content: STYLE_SVG,
        sentAt: '2026-11-19T10:00:30.000Z',
        seq: 1,
      },
      {
        kind: 'assistant',
        id: 'assistant-2',
        status: 'done',
        content: 'Sibling message, unaffected by the circle above.',
        sentAt: '2026-11-19T10:00:40.000Z',
        seq: 2,
      },
    ]);
    await page.goto(`/chat/${THREAD_ID}`);

    const messages = page.getByTestId('assistant-message');
    const circle = messages.first().locator('[data-testid="svg-sandbox"]').locator('circle');
    const sibling = messages.last().getByText('Sibling message, unaffected');

    await pauseBeforeAction(page, testInfo);
    await expect(circle).toBeVisible();
    expect(await circle.evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(255, 0, 0)');
    expect(await sibling.evaluate((el) => getComputedStyle(el).color)).not.toBe('rgb(255, 0, 0)');
  });

  test('an oversized SVG is capped to its message container width @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockChatApis(page, [
      {
        kind: 'assistant',
        id: 'assistant-1',
        status: 'done',
        content: OVERSIZED_SVG,
        sentAt: '2026-11-19T10:00:30.000Z',
        seq: 1,
      },
    ]);
    await page.goto(`/chat/${THREAD_ID}`);

    const message = page.getByTestId('assistant-message');
    const svg = message.locator('[data-testid="svg-sandbox"]').locator('svg');

    await pauseBeforeAction(page, testInfo);
    await expect(svg).toBeVisible();
    const [svgBox, messageBox] = await Promise.all([svg.boundingBox(), message.boundingBox()]);
    expect(svgBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    expect(svgBox!.width).toBeLessThanOrEqual(messageBox!.width + 1);
  });
});
