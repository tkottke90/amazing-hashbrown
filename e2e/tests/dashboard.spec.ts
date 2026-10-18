import { test, expect, type Page, type Locator, type APIRequestContext } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

// CM6's `.cm-content` is a real contenteditable root, not a form control —
// there's no `<label>`/`value` for `.fill()`/`getByLabel()` to use. Select
// all then insertText fires a real input event and replaces the whole
// selection in one shot, matching CodeMirror's own input pipeline more
// reliably than a keystroke-by-keystroke `.type()`.
async function setRawEditorContent(page: Page, dialog: Locator, text: string) {
  const content = dialog.locator('[data-testid="widget-drawer-raw-editor"] .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

async function setCsvEditorContent(page: Page, dialog: Locator, text: string) {
  const content = dialog.locator('[data-testid="widget-drawer-csv-editor"] .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

// Radix Select's popover content renders through a portal attached to
// <body>, not inside the drawer's own DOM subtree — so the option is
// queried page-wide, same as the trigger click is scoped to the drawer.
async function selectWidgetType(page: Page, dialog: Locator, label: string) {
  await dialog.getByTestId('widget-type-picker').click();
  await page.getByRole('option', { name: label }).click();
}

const suite: TestSuite = {
  id: 53,
  name: 'Dashboard',
  description:
    'Verifies the dashboard renders as the app landing page with a responsive widget grid',
  purpose: 'Catch regressions in the dashboard landing page and its grid responsiveness',
  tags: ['@smoke', '@user-workflow'],
  steps: [
    {
      tags: ['@smoke'],
      action: 'Load /',
      expectedOutcome:
        'Dashboard renders with at least one markdown widget showing title, subtitle, and rendered content',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'From Wiki, click the sidebar Dashboard link',
      expectedOutcome: 'Navigates to / with widgets visible',
      test: () => {},
    },
    {
      tags: ['@smoke'],
      action: 'Resize to mobile/tablet/desktop widths',
      expectedOutcome: 'Grid column count changes per breakpoint with no horizontal overflow',
      test: () => {},
    },
  ],
};

// Persistence suite (#178) — mutates real dashboard widget files on disk,
// so these run under @user-workflow only, never @smoke (which must not
// make any changes per e2e/AGENTS.md's tag table).
const persistenceSuite: TestSuite = {
  id: 54,
  name: 'Dashboard widget persistence',
  description: 'Verifies widget CRUD round-trips to disk and a broken file is recoverable',
  purpose:
    'Catch regressions in issue #178 — widgets must survive a reload, and a malformed file must stay recoverable rather than breaking the whole dashboard',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Add a widget, reload, delete it, reload again',
      expectedOutcome: 'The widget persists across the first reload and is gone after the second',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Corrupt a widget file via the raw API, reload, fix it through "Edit raw file"',
      expectedOutcome:
        'The dashboard shows an error card instead of failing to load; its drawer opens straight onto the Raw tab, and the widget renders normally once the fixed text is validated and saved',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open a healthy widget, switch to Raw, edit it directly, validate, save',
      expectedOutcome: 'Validate passes and Save persists the edit across a reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open a healthy widget, switch to Raw, break the frontmatter, validate',
      expectedOutcome:
        'An inline error appears and the Form tab stays unreachable until the text is fixed',
      test: () => {},
    },
  ],
};

async function gridColumnCount(page: Page): Promise<number> {
  const value = await page.locator('[data-testid="dashboard-grid"]').evaluate((el) => {
    return getComputedStyle(el).gridTemplateColumns;
  });
  return value.trim().split(/\s+/).length;
}

test.describe(
  '@smoke @user-workflow',
  {
    annotation: suiteAnnotations(suite),
  },
  () => {
    test('dashboard renders with widget content', async ({ page }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await expect(page.getByTestId('dashboard-grid')).toBeVisible();

      const firstCard = page.getByTestId('widget-card').first();
      await expect(firstCard).toBeVisible();
      // level: 2 disambiguates the widget's own <h2> title from the
      // markdown content's <h1> heading just below it, whose text
      // ("Welcome to Amazing Hashbrown") also contains "Welcome".
      await expect(
        firstCard.getByRole('heading', { level: 2, name: 'Welcome', exact: true }),
      ).toBeVisible();
      await expect(firstCard.getByText('Your AI Workspace')).toBeVisible();
      await expect(
        firstCard.getByRole('heading', { name: 'Welcome to Amazing Hashbrown' }),
      ).toBeVisible();
    });

    test('sidebar Dashboard link navigates home', async ({ page }, testInfo) => {
      await page.goto('/wiki');
      await pauseBeforeAction(page, testInfo);

      await page.getByRole('link', { name: 'Dashboard' }).click();

      await expect(page).toHaveURL('/');
      await expect(page.getByTestId('dashboard-grid')).toBeVisible();
    });

    test.describe('Mobile viewport (<640px)', () => {
      test.use({ viewport: { width: 375, height: 812 } });

      test('grid renders a single column with no horizontal overflow', async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(1);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(375 + 1);
      });
    });

    // Below 1024px there's only one state — a single-column stack by order,
    // w/h ignored entirely (#314's design spec §4.1) — the 2-column tablet
    // tier this used to assert no longer exists.
    test.describe('Sub-desktop viewport (640-1023px)', () => {
      test.use({ viewport: { width: 800, height: 900 } });

      test('grid renders a single column with no horizontal overflow', async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(1);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(800 + 1);
      });
    });

    // At/above 1024px the grid is a fixed 12-column track (#314) — every
    // widget spans `grid-column: span w`, not a responsive 1/2/3-column
    // stack.
    test.describe('Desktop viewport (>=1024px)', () => {
      test.use({ viewport: { width: 1280, height: 900 } });

      test('grid renders a 12-column fixed track with no horizontal overflow', async ({
        page,
      }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(12);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(1280 + 1);
      });
    });
  },
);

async function deleteWidgetIfExists(request: APIRequestContext, id: string) {
  await request.delete(`/api/v1/dashboards/default/widgets/${id}`).catch(() => {});
}

// Chart widget types suite (#313) — mutates real dashboard widget files on
// disk, so @user-workflow only, same reasoning as the persistence suite above.
const chartWidgetsSuite: TestSuite = {
  id: 55,
  name: 'Dashboard chart widget types',
  description:
    'Verifies Big Number, Line Graph, and Pie Graph widgets can be added, rendered, validated, and deleted',
  purpose:
    'Catch regressions in issue #313 — the three new widget types must persist and render like Markdown already does, and bad CSV/color input must block the save with an inline error',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Add a Big Number widget with no value',
      expectedOutcome: 'Renders "N/A" and persists across a reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add a Line Graph widget with valid CSV data',
      expectedOutcome:
        'Validate passes, the widget is created, an svg line renders, persists across a reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add a Pie Graph widget with valid CSV data',
      expectedOutcome:
        'Validate passes, the widget is created, an svg pie renders, persists across a reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Attempt to save a Line Graph widget whose CSV is missing its header',
      expectedOutcome: 'An inline validation error appears and no widget is created',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Seed one widget of each of the 4 types via the API, load the dashboard',
      expectedOutcome: 'All four render without error',
      test: () => {},
    },
  ],
};

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(chartWidgetsSuite),
  },
  () => {
    test('add a big-number widget with no value — renders N/A and persists', async ({
      page,
    }, testInfo) => {
      const title = `E2E big number ${testInfo.testId}`;
      let widgetId: string | null = null;

      try {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        await page.getByTestId('dashboard-add-widget').click();
        const addDrawer = page.locator('dialog[open]');
        await selectWidgetType(page, addDrawer, 'Big Number');
        await addDrawer.getByLabel('Title', { exact: true }).fill(title);
        await addDrawer.getByRole('button', { name: 'Save' }).click();

        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await expect(card).toBeVisible();
        await expect(card.getByText('N/A')).toBeVisible();

        const widgets = await page.request.get('/api/v1/dashboards/default/widgets');
        const body = (await widgets.json()) as Array<{
          status: string;
          widget?: { id: string; title: string };
        }>;
        widgetId =
          body.find((r) => r.status === 'ok' && r.widget?.title === title)?.widget?.id ?? null;

        await page.reload();
        await expect(
          page.getByTestId('widget-card').filter({ hasText: title }).getByText('N/A'),
        ).toBeVisible();
      } finally {
        if (widgetId) await deleteWidgetIfExists(page.request, widgetId);
      }
    });

    test('add a line-graph widget with valid CSV — renders a line and persists', async ({
      page,
    }, testInfo) => {
      const title = `E2E line graph ${testInfo.testId}`;
      let widgetId: string | null = null;

      try {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        await page.getByTestId('dashboard-add-widget').click();
        const addDrawer = page.locator('dialog[open]');
        await selectWidgetType(page, addDrawer, 'Line Graph');
        await addDrawer.getByLabel('Title', { exact: true }).fill(title);
        await setCsvEditorContent(page, addDrawer, 'label,value\n09:00,120\n09:05,135');
        await addDrawer.getByTestId('widget-drawer-validate').click();
        await addDrawer.getByRole('button', { name: 'Save' }).click();

        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await expect(card).toBeVisible();
        await expect(card.getByTestId('line-graph-widget').locator('svg path')).toHaveCount(1);

        const widgets = await page.request.get('/api/v1/dashboards/default/widgets');
        const body = (await widgets.json()) as Array<{
          status: string;
          widget?: { id: string; title: string };
        }>;
        widgetId =
          body.find((r) => r.status === 'ok' && r.widget?.title === title)?.widget?.id ?? null;

        await page.reload();
        await expect(page.getByTestId('widget-card').filter({ hasText: title })).toBeVisible();
      } finally {
        if (widgetId) await deleteWidgetIfExists(page.request, widgetId);
      }
    });

    test('add a pie-graph widget with valid CSV — renders segments and persists', async ({
      page,
    }, testInfo) => {
      const title = `E2E pie graph ${testInfo.testId}`;
      let widgetId: string | null = null;

      try {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        await page.getByTestId('dashboard-add-widget').click();
        const addDrawer = page.locator('dialog[open]');
        await selectWidgetType(page, addDrawer, 'Pie Graph');
        await addDrawer.getByLabel('Title', { exact: true }).fill(title);
        await setCsvEditorContent(page, addDrawer, 'label,value\nQuery,30\nAnalysis,25');
        await addDrawer.getByTestId('widget-drawer-validate').click();
        await addDrawer.getByRole('button', { name: 'Save' }).click();

        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await expect(card).toBeVisible();
        await expect(card.getByTestId('pie-graph-widget').locator('svg path')).toHaveCount(2);

        const widgets = await page.request.get('/api/v1/dashboards/default/widgets');
        const body = (await widgets.json()) as Array<{
          status: string;
          widget?: { id: string; title: string };
        }>;
        widgetId =
          body.find((r) => r.status === 'ok' && r.widget?.title === title)?.widget?.id ?? null;

        await page.reload();
        await expect(page.getByTestId('widget-card').filter({ hasText: title })).toBeVisible();
      } finally {
        if (widgetId) await deleteWidgetIfExists(page.request, widgetId);
      }
    });

    test('an invalid line-graph CSV blocks save with an inline error, no widget created', async ({
      page,
    }, testInfo) => {
      await page.goto('/');
      await pauseBeforeAction(page, testInfo);

      await page.getByTestId('dashboard-add-widget').click();
      const addDrawer = page.locator('dialog[open]');
      await selectWidgetType(page, addDrawer, 'Line Graph');
      const title = `E2E invalid csv ${testInfo.testId}`;
      await addDrawer.getByLabel('Title', { exact: true }).fill(title);
      // Missing the required "label,value" header row.
      await setCsvEditorContent(page, addDrawer, '09:00,120\n09:05,135');
      await addDrawer.getByRole('button', { name: 'Save' }).click();

      await expect(addDrawer.getByTestId('widget-drawer-raw-error')).toBeVisible();
      await expect(page.getByTestId('widget-card').filter({ hasText: title })).toHaveCount(0);
    });

    test('a dashboard seeded with one of each widget type renders all without error', async ({
      page,
    }, testInfo) => {
      const createdIds: string[] = [];
      const titles = {
        markdown: `E2E all-types md ${testInfo.testId}`,
        bigNumber: `E2E all-types num ${testInfo.testId}`,
        line: `E2E all-types line ${testInfo.testId}`,
        pie: `E2E all-types pie ${testInfo.testId}`,
      };

      async function seed(data: Record<string, unknown>) {
        const res = await page.request.post('/api/v1/dashboards/default/widgets', { data });
        createdIds.push(((await res.json()) as { id: string }).id);
      }

      try {
        await seed({ type: 'markdown', title: titles.markdown, content: 'hi' });
        await seed({ type: 'big-number', title: titles.bigNumber, value: 1 });
        await seed({ type: 'line-graph', title: titles.line, data: 'label,value\nA,1' });
        await seed({ type: 'pie-graph', title: titles.pie, data: 'label,value\nA,1' });

        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        for (const title of Object.values(titles)) {
          await expect(page.getByTestId('widget-card').filter({ hasText: title })).toBeVisible();
        }
      } finally {
        for (const id of createdIds) await deleteWidgetIfExists(page.request, id);
      }
    });
  },
);

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(persistenceSuite),
  },
  () => {
    test('add, reload, delete, reload — real backend, no mocking', async ({ page }, testInfo) => {
      const title = `E2E widget ${testInfo.testId}`;
      let widgetId: string | null = null;

      try {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        // Every widget drawer (add + one per existing widget) stays mounted
        // in the DOM simultaneously (a native <dialog> per instance) — only
        // the one with the `open` attribute is the one just opened, so
        // every field/button interaction below is scoped to it rather than
        // an unscoped getByLabel/getByRole, which would match all of them.
        await page.getByTestId('dashboard-add-widget').click();
        const addDrawer = page.locator('dialog[open]');
        // exact:true — "Subtitle" is also a label text here, and Playwright's
        // getByLabel does a case-insensitive substring match by default.
        await addDrawer.getByLabel('Title', { exact: true }).fill(title);
        await addDrawer.getByLabel('Content (Markdown)').fill('Added by an E2E test.');
        await addDrawer.getByRole('button', { name: 'Save' }).click();

        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await expect(card).toBeVisible();

        // Capture the id so cleanup works even if a later assertion fails.
        const widgets = await page.request.get('/api/v1/dashboards/default/widgets');
        const body = (await widgets.json()) as Array<{
          status: string;
          widget?: { id: string; title: string };
        }>;
        widgetId =
          body.find((r) => r.status === 'ok' && r.widget?.title === title)?.widget?.id ?? null;

        await page.reload();
        await expect(page.getByTestId('widget-card').filter({ hasText: title })).toBeVisible();

        page.once('dialog', (dialog) => dialog.accept());
        await page
          .getByTestId('widget-card')
          .filter({ hasText: title })
          .getByTestId('widget-delete-button')
          .click();

        await expect(page.getByTestId('widget-card').filter({ hasText: title })).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId('widget-card').filter({ hasText: title })).toHaveCount(0);
        widgetId = null; // already deleted through the UI
      } finally {
        if (widgetId) await deleteWidgetIfExists(page.request, widgetId);
      }
    });

    test('a malformed widget file surfaces an error card and is recoverable via "Edit raw file"', async ({
      page,
    }, testInfo) => {
      const title = `E2E broken widget ${testInfo.testId}`;
      const created = await page.request.post('/api/v1/dashboards/default/widgets', {
        data: { type: 'markdown', title, content: 'original content' },
      });
      const widget = (await created.json()) as { id: string };

      try {
        // Corrupt the file directly through the raw endpoint — no UI
        // action produces this state, so it's seeded via the API per
        // e2e/AGENTS.md's "mock/seed the state, not the live interaction".
        await page.request.put(`/api/v1/dashboards/default/widgets/${widget.id}/raw`, {
          data: { raw: '---\ntitle: [unterminated\n---\nBody' },
        });

        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        const errorCard = page.getByTestId('widget-error-card');
        await expect(errorCard).toBeVisible();
        await expect(errorCard.getByText('Unable to load this widget')).toBeVisible();

        await errorCard.getByTestId('widget-edit-raw-button').click();
        const rawDrawer = page.locator('dialog[open]');
        // Lands straight on Raw — Form has nothing valid to show for a file
        // that never parsed.
        await expect(rawDrawer.getByTestId('widget-drawer-raw-editor')).toBeVisible();

        await setRawEditorContent(
          page,
          rawDrawer,
          '---\ntitle: Fixed widget\ntype: markdown\norder: 0\n---\nFixed content',
        );
        await rawDrawer.getByTestId('widget-drawer-validate').click();
        await rawDrawer.getByRole('button', { name: 'Save' }).click();

        await page.reload();
        await expect(page.getByTestId('widget-error-card')).toHaveCount(0);
        await expect(
          page.getByTestId('widget-card').filter({ hasText: 'Fixed widget' }),
        ).toBeVisible();
      } finally {
        await deleteWidgetIfExists(page.request, widget.id);
      }
    });

    test('editing a healthy widget directly in Raw persists after validate + save', async ({
      page,
    }, testInfo) => {
      const title = `E2E raw-edit widget ${testInfo.testId}`;
      const created = await page.request.post('/api/v1/dashboards/default/widgets', {
        data: { type: 'markdown', title, content: 'original content' },
      });
      const widget = (await created.json()) as { id: string };

      try {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await card.getByTestId('widget-edit-button').click();
        const drawer = page.locator('dialog[open]');

        await drawer.getByTestId('widget-drawer-tab-raw').click();
        await setRawEditorContent(
          page,
          drawer,
          `---\ntitle: "${title}"\ntype: "markdown"\norder: 0\n---\n\nEdited directly in Raw.`,
        );

        await drawer.getByTestId('widget-drawer-validate').click();
        await drawer.getByRole('button', { name: 'Save' }).click();

        // Confirm the dialog actually closed (the save went through) before
        // reloading — but don't assert on the card's text pre-reload: the
        // dialog (and its CodeMirror content, which has the same text) is a
        // DOM descendant of the widget-card element and stays mounted even
        // once closed, so a `card.getByText(...)` here would ambiguously
        // match both the real rendered content and the editor's own line.
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await page.reload();
        await expect(
          page
            .getByTestId('widget-card')
            .filter({ hasText: title })
            .getByText('Edited directly in Raw.'),
        ).toBeVisible();
      } finally {
        await deleteWidgetIfExists(page.request, widget.id);
      }
    });

    test('breaking the frontmatter in Raw shows an inline error and blocks the Form tab', async ({
      page,
    }, testInfo) => {
      const title = `E2E raw-break widget ${testInfo.testId}`;
      const created = await page.request.post('/api/v1/dashboards/default/widgets', {
        data: { type: 'markdown', title, content: 'original content' },
      });
      const widget = (await created.json()) as { id: string };

      try {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await card.getByTestId('widget-edit-button').click();
        const drawer = page.locator('dialog[open]');

        await drawer.getByTestId('widget-drawer-tab-raw').click();
        await setRawEditorContent(page, drawer, '---\ntitle: [unterminated\n---\nBroken');
        await drawer.getByTestId('widget-drawer-validate').click();

        await expect(drawer.getByTestId('widget-drawer-raw-error')).toBeVisible();
        await drawer.getByTestId('widget-drawer-tab-form').click();
        // Still on Raw — the Form tab click itself re-checks and stays put.
        await expect(drawer.getByTestId('widget-drawer-raw-editor')).toBeVisible();
      } finally {
        await deleteWidgetIfExists(page.request, widget.id);
      }
    });
  },
);

// Drag reorder + resize suite (#314) — mutates real dashboard widget files
// on disk and needs the full 12-column desktop grid, so @user-workflow
// only, same reasoning as the other mutating suites above.
const layoutSuite: TestSuite = {
  id: 56,
  name: 'Dashboard widget layout',
  description: 'Verifies drag-reorder and resize persist to disk and broadcast live',
  purpose:
    "Catch regressions in issue #314 — a drag or resize must survive a reload, and another open tab must pick up the change over SSE without a manual refresh, since that's the whole point of the feature over #179's non-persistent foundation",
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Enter Edit Mode, drag one widget onto another, reload',
      expectedOutcome:
        "The dragged widget lands at the target's former slot and the new order survives the reload",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: "Enter Edit Mode, drag a widget's corner resize handle, reload",
      expectedOutcome:
        'The widget grows beyond its original span and the new size survives the reload',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open a second tab on the same dashboard, reorder in the first tab',
      expectedOutcome: "The second tab's widget order updates live, with no manual refresh",
      test: () => {},
    },
  ],
};

test.describe(
  '@user-workflow',
  {
    annotation: suiteAnnotations(layoutSuite),
  },
  () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    async function seedMarkdown(page: Page, title: string, content = 'x'): Promise<string> {
      const res = await page.request.post('/api/v1/dashboards/default/widgets', {
        data: { type: 'markdown', title, content },
      });
      return ((await res.json()) as { id: string }).id;
    }

    // :visible excludes each card's own (closed, but still in the DOM)
    // "Edit widget" drawer heading — also an <h2>, nested inside the card.
    async function cardTitles(page: Page): Promise<string[]> {
      return page.getByTestId('widget-card').locator('h2:visible').allTextContents();
    }

    test('drag-reordering a widget onto another persists across reload', async ({
      page,
    }, testInfo) => {
      const titleA = `E2E layout A ${testInfo.testId}`;
      const titleB = `E2E layout B ${testInfo.testId}`;
      const createdIds: string[] = [];

      try {
        createdIds.push(await seedMarkdown(page, titleA));
        createdIds.push(await seedMarkdown(page, titleB));

        await page.goto('/');
        await pauseBeforeAction(page, testInfo);
        await expect(page.getByTestId('widget-card').filter({ hasText: titleB })).toBeVisible();

        await page.getByTestId('dashboard-edit-mode-toggle').click();

        const cardA = page.getByTestId('widget-card').filter({ hasText: titleA });
        const cardB = page.getByTestId('widget-card').filter({ hasText: titleB });
        // B was created after A, so A already sits immediately before B —
        // dragging A onto B would be a no-op under "insert before target"
        // semantics (ADR-0008). Drag B onto A instead, a genuine move.
        const handleB = cardB.getByTestId('widget-drag-handle');

        const handleBox = await handleB.boundingBox();
        const targetBox = await cardA.boundingBox();
        if (!handleBox || !targetBox) throw new Error('could not measure drag elements');

        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          targetBox.x + targetBox.width / 2,
          targetBox.y + targetBox.height / 2,
          { steps: 10 },
        );
        await page.mouse.up();

        await expect(async () => {
          const titles = await cardTitles(page);
          expect(titles.indexOf(titleB)).toBeLessThan(titles.indexOf(titleA));
        }).toPass();

        await page.reload();
        await pauseBeforeAction(page, testInfo);
        const titlesAfterReload = await cardTitles(page);
        expect(titlesAfterReload.indexOf(titleB)).toBeLessThan(titlesAfterReload.indexOf(titleA));
      } finally {
        for (const id of createdIds) await deleteWidgetIfExists(page.request, id);
      }
    });

    test('resizing a widget via its corner handle persists across reload', async ({
      page,
    }, testInfo) => {
      const title = `E2E layout resize ${testInfo.testId}`;
      let widgetId: string | null = null;

      try {
        widgetId = await seedMarkdown(page, title);

        await page.goto('/');
        await pauseBeforeAction(page, testInfo);
        const card = page.getByTestId('widget-card').filter({ hasText: title });
        await expect(card).toBeVisible();
        const originalBox = await card.boundingBox();
        if (!originalBox) throw new Error('could not measure widget card');

        await page.getByTestId('dashboard-edit-mode-toggle').click();
        const handle = card.getByTestId('widget-resize-handle');
        const handleBox = await handle.boundingBox();
        if (!handleBox) throw new Error('could not measure resize handle');

        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        // Drag well past the markdown minimum (3×2) in both directions —
        // several columns and rows, not a fine-grained pixel target, so the
        // assertion below only needs "grew", not an exact w/h.
        await page.mouse.move(
          handleBox.x + handleBox.width / 2 + 400,
          handleBox.y + handleBox.height / 2 + 300,
          { steps: 10 },
        );
        await page.mouse.up();

        await expect(async () => {
          const box = await card.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.width).toBeGreaterThan(originalBox.width);
          expect(box!.height).toBeGreaterThan(originalBox.height);
        }).toPass();

        await page.reload();
        await pauseBeforeAction(page, testInfo);
        const boxAfterReload = await page
          .getByTestId('widget-card')
          .filter({ hasText: title })
          .boundingBox();
        expect(boxAfterReload).not.toBeNull();
        expect(boxAfterReload!.width).toBeGreaterThan(originalBox.width);
        expect(boxAfterReload!.height).toBeGreaterThan(originalBox.height);
      } finally {
        if (widgetId) await deleteWidgetIfExists(page.request, widgetId);
      }
    });

    test('a second tab picks up a reorder live over SSE, with no manual refresh', async ({
      page,
      context,
    }, testInfo) => {
      const titleA = `E2E layout live A ${testInfo.testId}`;
      const titleB = `E2E layout live B ${testInfo.testId}`;
      const createdIds: string[] = [];

      try {
        createdIds.push(await seedMarkdown(page, titleA));
        createdIds.push(await seedMarkdown(page, titleB));

        await page.goto('/');
        await pauseBeforeAction(page, testInfo);
        await expect(page.getByTestId('widget-card').filter({ hasText: titleB })).toBeVisible();

        const secondTab = await context.newPage();
        await secondTab.goto('/');
        await expect(
          secondTab.getByTestId('widget-card').filter({ hasText: titleB }),
        ).toBeVisible();

        await page.getByTestId('dashboard-edit-mode-toggle').click();
        const cardA = page.getByTestId('widget-card').filter({ hasText: titleA });
        const cardB = page.getByTestId('widget-card').filter({ hasText: titleB });
        // B was created after A, so A already sits immediately before B —
        // dragging A onto B would be a no-op under "insert before target"
        // semantics (ADR-0008). Drag B onto A instead, a genuine move.
        const handleB = cardB.getByTestId('widget-drag-handle');

        const handleBox = await handleB.boundingBox();
        const targetBox = await cardA.boundingBox();
        if (!handleBox || !targetBox) throw new Error('could not measure drag elements');

        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          targetBox.x + targetBox.width / 2,
          targetBox.y + targetBox.height / 2,
          { steps: 10 },
        );
        await page.mouse.up();

        // No reload or refresh on secondTab — the reorder must arrive over
        // the standing SSE channel (dashboard_reordered) on its own.
        await expect(async () => {
          const titles = await secondTab
            .getByTestId('widget-card')
            .locator('h2:visible')
            .allTextContents();
          expect(titles.indexOf(titleB)).toBeLessThan(titles.indexOf(titleA));
        }).toPass();

        await secondTab.close();
      } finally {
        for (const id of createdIds) await deleteWidgetIfExists(page.request, id);
      }
    });
  },
);
