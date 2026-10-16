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

    test.describe('Tablet viewport (640-1023px)', () => {
      test.use({ viewport: { width: 800, height: 900 } });

      test('grid renders two columns with no horizontal overflow', async ({ page }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(2);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(800 + 1);
      });
    });

    test.describe('Desktop viewport (>=1024px)', () => {
      test.use({ viewport: { width: 1280, height: 900 } });

      test('grid renders three columns with no horizontal overflow', async ({ page }, testInfo) => {
        await page.goto('/');
        await pauseBeforeAction(page, testInfo);

        expect(await gridColumnCount(page)).toBe(3);

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(1280 + 1);
      });
    });
  },
);

async function deleteWidgetIfExists(request: APIRequestContext, id: string) {
  await request.delete(`/api/v1/dashboards/default/widgets/${id}`).catch(() => {});
}

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
        data: { title, content: 'original content' },
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
        data: { title, content: 'original content' },
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

        // The dialog (and its still-mounted CodeMirror content, which would
        // otherwise also match the text below since it's nested inside the
        // same widget-card element) must actually close before checking the
        // card's real rendered content — proof the save went through.
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await expect(card.getByText('Edited directly in Raw.')).toBeVisible();
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
        data: { title, content: 'original content' },
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
