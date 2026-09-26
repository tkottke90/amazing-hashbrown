import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 31,
  name: 'Wiki Resizable Panels & Recenter Graph',
  description:
    'Verifies the wiki canvas|chat and files|document splits can be resized by drag and keyboard, persist across reloads, reset via the Reset layout button and separator double-click, and that the Recenter graph button brings every node back into view',
  purpose:
    'Fixed column widths cramped long documents and page titles; resizable panels let the user make room where they are working, and because the graph deliberately does not redraw on resize, Recenter graph is the way back when nodes end up out of view',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Drag the canvas|chat separator left, then reload',
      expectedOutcome: 'The chat panel widens and keeps its new width after reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Resize the chat, then switch between Graph and Document views',
      expectedOutcome: 'The chat width is shared by both views and does not jump',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Drag the files|document separator in Document view, then reload',
      expectedOutcome: 'The file list widens and keeps its width after reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Resize both splits, click Reset layout from Graph view, then open Document view',
      expectedOutcome:
        'Both splits are back at their defaults, including the files split that was unmounted when Reset was clicked',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action:
        'In Document view, widen the chat until the file list is squeezed, then click Reset layout',
      expectedOutcome:
        'Both splits return to their defaults — the file list is back at its default width, not a rescaled squeezed width',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Resize the chat, double-click the separator, then reload',
      expectedOutcome: 'The split resets to its default and stays reset after reload',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Focus the canvas|chat separator and press ArrowLeft',
      expectedOutcome: 'The chat panel widens (keyboard accessible resize)',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Pan the graph so nodes leave the canvas, then click Recenter graph',
      expectedOutcome: 'Every node is back inside the graph canvas',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Widen the chat so the graph canvas shrinks, then click Recenter graph',
      expectedOutcome: 'Every node fits inside the narrower graph canvas',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Filter every domain off the graph',
      expectedOutcome: 'The Recenter graph button is disabled — there is nothing to recenter',
      test: () => {},
    },
  ],
};

// Element ids from ui/src/pages/wiki/use-wiki-layout.ts — react-resizable-panels
// mirrors each panel/separator id into data-testid.
const CHAT_PANEL = 'wiki-chat';
const FILES_PANEL = 'wiki-files';
const OUTER_SEPARATOR = 'wiki-outer-separator';
const DOCUMENT_SEPARATOR = 'wiki-document-separator';

// Allowed slack when comparing widths — sub-pixel rounding from the
// percentage-based layout.
const TOLERANCE_PX = 4;

const DOMAIN_A = { id: 'domain-a', domain: 'Domain A', tags: [] };
const DOMAIN_B = { id: 'domain-b', domain: 'Domain B', tags: [] };

const mockGraph = {
  nodes: [
    {
      id: 'domain-a:entities/n1',
      title: 'Node One',
      type: 'concept',
      tags: [],
      domainId: 'domain-a',
    },
    {
      id: 'domain-a:entities/n2',
      title: 'Node Two',
      type: 'concept',
      tags: [],
      domainId: 'domain-a',
    },
    {
      id: 'domain-a:entities/n3',
      title: 'Node Three',
      type: 'concept',
      tags: [],
      domainId: 'domain-a',
    },
    {
      id: 'domain-b:entities/n4',
      title: 'Node Four',
      type: 'concept',
      tags: [],
      domainId: 'domain-b',
    },
  ],
  edges: [
    {
      source: 'domain-a:entities/n1',
      target: 'domain-a:entities/n2',
      type: 'references',
      domainId: 'domain-a',
    },
    {
      source: 'domain-a:entities/n2',
      target: 'domain-a:entities/n3',
      type: 'references',
      domainId: 'domain-a',
    },
  ],
};

const mockPageList = [
  { filename: 'entities/n1.md', title: 'Node One', type: 'entity' },
  { filename: 'entities/n2.md', title: 'Node Two', type: 'entity' },
];

async function mockWikiApis(page: Page) {
  await page.route('**/api/v1/wiki/domains', async (route: Route) => {
    await route.fulfill({ json: [DOMAIN_A, DOMAIN_B] });
  });
  await page.route('**/api/v1/wiki/graph', async (route: Route) => {
    await route.fulfill({ json: mockGraph });
  });
  await page.route('**/api/v1/wiki/domains/*/pages', async (route: Route) => {
    await route.fulfill({ json: mockPageList });
  });
}

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element is not visible, so it has no width');
  return box.width;
}

/** Drags a separator horizontally by dx pixels using real pointer events. */
async function dragSeparator(page: Page, testId: string, dx: number) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`separator ${testId} is not visible`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

/** Graph node circles and the SVG canvas they're drawn in. */
function graphParts(page: Page) {
  const nodes = page.getByTestId('graph-nodes').locator('circle');
  const svg = page.locator('svg:has([data-testid="graph-nodes"])');
  return { nodes, svg };
}

/** Waits for the force simulation to stop moving nodes, so position checks are deterministic. */
async function waitForGraphToSettle(page: Page) {
  const { nodes } = graphParts(page);
  await expect(nodes).toHaveCount(mockGraph.nodes.length);
  let previous = '';
  await expect
    .poll(
      async () => {
        const current = (
          await nodes.evaluateAll((els) =>
            els.map(
              (el) =>
                `${Math.round(Number(el.getAttribute('cx')))},${Math.round(Number(el.getAttribute('cy')))}`,
            ),
          )
        ).join('|');
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { intervals: [250], timeout: 15_000 },
    )
    .toBe(true);
}

/** How many node circles lie fully inside the SVG's on-screen box. */
async function countNodesInsideCanvas(page: Page): Promise<number> {
  const { nodes, svg } = graphParts(page);
  const canvas = await svg.boundingBox();
  if (!canvas) throw new Error('graph svg is not visible');
  let inside = 0;
  for (const node of await nodes.all()) {
    const box = await node.boundingBox();
    if (
      box &&
      box.x >= canvas.x - 1 &&
      box.y >= canvas.y - 1 &&
      box.x + box.width <= canvas.x + canvas.width + 1 &&
      box.y + box.height <= canvas.y + canvas.height + 1
    ) {
      inside += 1;
    }
  }
  return inside;
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test.beforeEach(async ({ page }) => {
      await mockWikiApis(page);
    });

    test('dragging the canvas|chat separator widens the chat and persists across reload', async ({
      page,
    }, testInfo) => {
      await page.goto('/wiki');
      const chat = page.getByTestId(CHAT_PANEL);
      const initial = await width(chat);

      await pauseBeforeAction(page, testInfo);
      await dragSeparator(page, OUTER_SEPARATOR, -120);
      const resized = await width(chat);
      expect(resized).toBeGreaterThan(initial + 100);

      await page.reload();
      await expect
        .poll(async () => Math.abs((await width(page.getByTestId(CHAT_PANEL))) - resized))
        .toBeLessThan(TOLERANCE_PX);
    });

    test('the chat width is shared by Graph and Document views', async ({ page }, testInfo) => {
      await page.goto('/wiki');
      await dragSeparator(page, OUTER_SEPARATOR, -120);
      const resized = await width(page.getByTestId(CHAT_PANEL));

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Document' }).click();
      await expect(page.getByTestId(FILES_PANEL)).toBeVisible();

      expect(Math.abs((await width(page.getByTestId(CHAT_PANEL))) - resized)).toBeLessThan(
        TOLERANCE_PX,
      );
    });

    test('dragging the files|document separator widens the file list and persists', async ({
      page,
    }, testInfo) => {
      await page.goto('/wiki?view=document&domain=domain-a');
      const files = page.getByTestId(FILES_PANEL);
      await expect(page.getByRole('button', { name: 'Node One' })).toBeVisible();
      const initial = await width(files);

      await pauseBeforeAction(page, testInfo);
      await dragSeparator(page, DOCUMENT_SEPARATOR, 40);
      const resized = await width(files);
      expect(resized).toBeGreaterThan(initial + 30);

      await page.reload();
      await expect(page.getByRole('button', { name: 'Node One' })).toBeVisible();
      expect(Math.abs((await width(page.getByTestId(FILES_PANEL))) - resized)).toBeLessThan(
        TOLERANCE_PX,
      );
    });

    test('Reset layout from Graph view restores both splits, including the unmounted files split', async ({
      page,
    }, testInfo) => {
      await page.goto('/wiki?view=document&domain=domain-a');
      await expect(page.getByRole('button', { name: 'Node One' })).toBeVisible();
      const defaultFiles = await width(page.getByTestId(FILES_PANEL));
      const defaultChat = await width(page.getByTestId(CHAT_PANEL));

      await dragSeparator(page, DOCUMENT_SEPARATOR, 40);
      expect(await width(page.getByTestId(FILES_PANEL))).toBeGreaterThan(defaultFiles + 30);
      await dragSeparator(page, OUTER_SEPARATOR, -120);
      expect(await width(page.getByTestId(CHAT_PANEL))).toBeGreaterThan(defaultChat + 100);

      await page.getByRole('button', { name: 'Graph' }).click();
      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Reset layout' }).click();

      await expect
        .poll(async () => Math.abs((await width(page.getByTestId(CHAT_PANEL))) - defaultChat))
        .toBeLessThan(TOLERANCE_PX);

      await page.getByRole('button', { name: 'Document' }).click();
      await expect(page.getByTestId(FILES_PANEL)).toBeVisible();
      expect(Math.abs((await width(page.getByTestId(FILES_PANEL))) - defaultFiles)).toBeLessThan(
        TOLERANCE_PX,
      );
    });

    test('Reset layout from Document view restores the file list even after it was squeezed', async ({
      page,
    }, testInfo) => {
      await page.goto('/wiki?view=document&domain=domain-a');
      await expect(page.getByRole('button', { name: 'Node One' })).toBeVisible();
      const defaultFiles = await width(page.getByTestId(FILES_PANEL));
      const defaultChat = await width(page.getByTestId(CHAT_PANEL));

      // Widening the chat shrinks the canvas until the document panel hits its
      // minimum, which squeezes the file list below its default. Reset has to
      // undo that even though both splits reset in the same tick.
      await dragSeparator(page, DOCUMENT_SEPARATOR, 40);
      await dragSeparator(page, OUTER_SEPARATOR, -150);
      expect(await width(page.getByTestId(FILES_PANEL))).toBeLessThan(defaultFiles - 10);

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Reset layout' }).click();

      await expect
        .poll(async () => Math.abs((await width(page.getByTestId(CHAT_PANEL))) - defaultChat))
        .toBeLessThan(TOLERANCE_PX);
      await expect
        .poll(async () => Math.abs((await width(page.getByTestId(FILES_PANEL))) - defaultFiles))
        .toBeLessThan(TOLERANCE_PX);
    });

    test('double-clicking a separator resets its split and the reset survives reload', async ({
      page,
    }, testInfo) => {
      await page.goto('/wiki');
      const defaultChat = await width(page.getByTestId(CHAT_PANEL));
      await dragSeparator(page, OUTER_SEPARATOR, -120);
      expect(await width(page.getByTestId(CHAT_PANEL))).toBeGreaterThan(defaultChat + 100);

      await pauseBeforeAction(page, testInfo);
      await page.getByTestId(OUTER_SEPARATOR).dblclick();
      await expect
        .poll(async () => Math.abs((await width(page.getByTestId(CHAT_PANEL))) - defaultChat))
        .toBeLessThan(TOLERANCE_PX);

      await page.reload();
      await expect
        .poll(async () => Math.abs((await width(page.getByTestId(CHAT_PANEL))) - defaultChat))
        .toBeLessThan(TOLERANCE_PX);
    });

    test('the separator can be resized with the keyboard', async ({ page }, testInfo) => {
      await page.goto('/wiki');
      const chat = page.getByTestId(CHAT_PANEL);
      const initial = await width(chat);

      await pauseBeforeAction(page, testInfo);
      await page.getByTestId(OUTER_SEPARATOR).focus();
      await page.keyboard.press('ArrowLeft');

      await expect.poll(() => width(chat)).toBeGreaterThan(initial + 2);
    });

    test('Recenter graph brings nodes back after panning them out of view', async ({
      page,
    }, testInfo) => {
      await page.goto('/wiki');
      await waitForGraphToSettle(page);
      const { svg } = graphParts(page);
      const canvas = await svg.boundingBox();
      if (!canvas) throw new Error('graph svg is not visible');

      // Pan by dragging empty canvas near the top-left corner far to the right,
      // pushing the nodes off the canvas's right edge.
      await page.mouse.move(canvas.x + 8, canvas.y + 8);
      await page.mouse.down();
      await page.mouse.move(canvas.x + canvas.width - 8, canvas.y + canvas.height - 8, {
        steps: 10,
      });
      await page.mouse.up();
      expect(await countNodesInsideCanvas(page)).toBeLessThan(mockGraph.nodes.length);

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Recenter graph' }).click();

      await expect.poll(() => countNodesInsideCanvas(page)).toBe(mockGraph.nodes.length);
    });

    test('Recenter graph fits every node after the chat is widened', async ({ page }, testInfo) => {
      await page.goto('/wiki');
      await waitForGraphToSettle(page);

      await dragSeparator(page, OUTER_SEPARATOR, -250);

      await pauseBeforeAction(page, testInfo);
      await page.getByRole('button', { name: 'Recenter graph' }).click();

      await expect.poll(() => countNodesInsideCanvas(page)).toBe(mockGraph.nodes.length);
    });

    test('Recenter graph is disabled when no nodes are shown', async ({ page }) => {
      await page.goto('/wiki');
      const recenter = page.getByRole('button', { name: 'Recenter graph' });
      await expect(recenter).toBeEnabled();

      await page.getByTitle(DOMAIN_A.domain).click();
      await page.getByTitle(DOMAIN_B.domain).click();

      await expect(recenter).toBeDisabled();
    });
  },
);
