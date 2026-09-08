import { test, expect, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 20,
  name: 'Wiki Graph Edge Persistence',
  description:
    "Verifies the wiki graph view keeps rendering edges after a tab switch away and back, and after toggling a domain's visibility — regression coverage for issue #109",
  purpose:
    'Edges previously disappeared (nodes stayed visible) after either interaction because d3-force mutated shared edge objects in place; this guards against that regressing',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load the wiki graph, switch to the Document tab, then back to Graph',
      expectedOutcome: 'The same edges that rendered on first load are still rendered',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Toggle a domain's visibility off, then back on, in the domain filter",
      expectedOutcome:
        'Edges among the remaining nodes render while toggled off, and are fully restored once toggled back on',
      test: () => {},
    },
  ],
};

const DOMAIN_A = { id: 'domain-a', domain: 'Domain A', tags: [] };
const DOMAIN_B = { id: 'domain-b', domain: 'Domain B', tags: [] };

// Ids follow the real `${wikiId}:${pageStem}` namespacing the API produces
// (issue #148) — n1/n2 belong to domain-a, n3 to domain-b, so n2->n3 is a
// cross-wiki edge.
const mockGraph = {
  nodes: [
    {
      id: 'domain-a:entities/n1',
      title: 'Node One',
      type: 'concept',
      tags: [],
      domainId: DOMAIN_A.id,
    },
    {
      id: 'domain-a:entities/n2',
      title: 'Node Two',
      type: 'concept',
      tags: [],
      domainId: DOMAIN_A.id,
    },
    {
      id: 'domain-b:entities/n3',
      title: 'Node Three',
      type: 'concept',
      tags: [],
      domainId: DOMAIN_B.id,
    },
  ],
  edges: [
    {
      source: 'domain-a:entities/n1',
      target: 'domain-a:entities/n2',
      type: 'references',
      domainId: DOMAIN_A.id,
    },
    {
      source: 'domain-a:entities/n2',
      target: 'domain-b:entities/n3',
      type: 'references',
      domainId: DOMAIN_A.id,
    },
    // derived_from edges are hidden by default — this one should never render,
    // in any scenario below, proving the fix didn't accidentally start showing it.
    {
      source: 'domain-a:entities/n1',
      target: 'domain-b:entities/n3',
      type: 'derived_from',
      domainId: DOMAIN_A.id,
    },
  ],
};

// 2 non-derived_from edges are visible with both domains enabled.
const VISIBLE_EDGE_COUNT = 2;
// Toggling domain-b off removes n3, which drops the n2->n3 edge, leaving n1->n2.
const EDGE_COUNT_WITH_DOMAIN_B_HIDDEN = 1;
// The cross-wiki edge (n2 -> n3) styling color from graph-view.tsx.
const CROSS_WIKI_EDGE_COLOR = '#0ea5e9';

async function mockWikiApis(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    await route.fulfill({ json: [DOMAIN_A, DOMAIN_B] });
  });
  await page.route('**/api/v1/wiki/graph', async (route: Route) => {
    await route.fulfill({ json: mockGraph });
  });
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('edges persist after switching to Document and back to Graph', async ({
      page,
    }, testInfo) => {
      await mockWikiApis(page);
      await page.goto('/wiki');

      const edges = page.getByTestId('graph-edges').locator('line');
      await expect(edges).toHaveCount(VISIBLE_EDGE_COUNT);

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Document' }).click();
      await page.getByRole('button', { name: 'Graph' }).click();

      await expect(edges).toHaveCount(VISIBLE_EDGE_COUNT);
    });

    test('edges persist after toggling a domain off and back on', async ({ page }, testInfo) => {
      await mockWikiApis(page);
      await page.goto('/wiki');

      const edges = page.getByTestId('graph-edges').locator('line');
      await expect(edges).toHaveCount(VISIBLE_EDGE_COUNT);

      await pauseBeforeAction(page, testInfo);
      await page.getByTitle(DOMAIN_B.domain).click();
      await expect(edges).toHaveCount(EDGE_COUNT_WITH_DOMAIN_B_HIDDEN);

      await page.getByTitle(DOMAIN_B.domain).click();
      await expect(edges).toHaveCount(VISIBLE_EDGE_COUNT);
    });
  },
);

const crossWikiSuite: TestSuite = {
  id: 25,
  name: 'Wiki Graph Cross-Wiki Edges & Editor Navigation',
  description:
    'Verifies a cross-wiki graph edge renders with distinct styling and that opening a graph node in the editor requests the correct, un-namespaced page path — regression coverage for issue #148',
  purpose:
    'Graph node/edge ids became `${wikiId}:${pageStem}`-namespaced to support cross-wiki references; this guards against the wiki id prefix leaking into the page-fetch URL, and against a cross-wiki edge losing its distinguishing style',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action:
        'Load the wiki graph with nodes from two different wikis connected by a cross-wiki edge',
      expectedOutcome:
        "The cross-wiki edge renders in its distinct color, separate from the same-wiki edge's color",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Hover a graph node and click "Open in editor"',
      expectedOutcome:
        'The page is fetched using its bare page path, with the wiki id prefix stripped off',
      test: () => {},
    },
  ],
};

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(crossWikiSuite),
  },
  () => {
    test('cross-wiki edge renders with distinct styling', async ({ page }) => {
      await mockWikiApis(page);
      await page.goto('/wiki');

      const edges = page.getByTestId('graph-edges').locator('line');
      await expect(edges).toHaveCount(VISIBLE_EDGE_COUNT);

      const crossWikiEdges = page.locator(
        `[data-testid="graph-edges"] line[stroke="${CROSS_WIKI_EDGE_COLOR}"]`,
      );
      await expect(crossWikiEdges).toHaveCount(1);

      const sameWikiEdges = page.locator(
        `[data-testid="graph-edges"] line:not([stroke="${CROSS_WIKI_EDGE_COLOR}"])`,
      );
      await expect(sameWikiEdges).toHaveCount(VISIBLE_EDGE_COUNT - 1);
    });

    test('opening a node in the editor requests the un-namespaced page path', async ({ page }) => {
      await mockWikiApis(page);

      let requestedUrl: string | null = null;
      await page.route('**/api/v1/wiki/domains/*/pages/**', async (route: Route) => {
        requestedUrl = route.request().url();
        await route.fulfill({
          json: {
            filename: 'entities/n1.md',
            title: 'Node One',
            type: 'concept',
            frontmatter: {},
            content: 'Node One content.',
            links: {},
          },
        });
      });

      await page.goto('/wiki');
      const firstNode = page.getByTestId('graph-nodes').locator('circle').first();
      await firstNode.hover();
      await page.getByRole('button', { name: 'Open in editor' }).click();

      await expect(page.getByRole('button', { name: 'Document' })).toHaveClass(/bg-muted/);
      expect(requestedUrl).not.toBeNull();
      expect(requestedUrl).toContain('/domains/domain-a/pages/entities/n1');
      expect(requestedUrl).not.toContain('domain-a:entities');
      expect(requestedUrl).not.toContain('domain-a%3Aentities');
    });
  },
);
