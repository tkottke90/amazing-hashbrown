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

const mockGraph = {
  nodes: [
    { id: 'n1', title: 'Node One', type: 'concept', tags: [], domainId: DOMAIN_A.id },
    { id: 'n2', title: 'Node Two', type: 'concept', tags: [], domainId: DOMAIN_A.id },
    { id: 'n3', title: 'Node Three', type: 'concept', tags: [], domainId: DOMAIN_B.id },
  ],
  edges: [
    { source: 'n1', target: 'n2', type: 'references', domainId: DOMAIN_A.id },
    { source: 'n2', target: 'n3', type: 'contradicts', domainId: DOMAIN_B.id },
    // derived_from edges are hidden by default — this one should never render,
    // in any scenario below, proving the fix didn't accidentally start showing it.
    { source: 'n1', target: 'n3', type: 'derived_from', domainId: DOMAIN_A.id },
  ],
};

// 2 non-derived_from edges are visible with both domains enabled.
const VISIBLE_EDGE_COUNT = 2;
// Toggling domain-b off removes n3, which drops the n2->n3 edge, leaving n1->n2.
const EDGE_COUNT_WITH_DOMAIN_B_HIDDEN = 1;

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
