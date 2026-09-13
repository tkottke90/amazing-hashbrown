import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 29,
  name: 'Settings Tools admin drawer',
  description:
    'Verifies the Settings > Tools table and its per-tool admin drawer: search, opening a row, editing description/instructions, saving, and resetting to defaults',
  purpose:
    "Ensure users can view and edit every tool's config.yaml-backed settings (2026-09-13 redesign) without a live backend",
  tags: ['@functional', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Search the tools table',
      expectedOutcome: 'Only rows matching the query remain visible',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click a row to open its admin drawer',
      expectedOutcome: "The drawer opens pre-filled with that tool's own settings",
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Edit the description and click Save',
      expectedOutcome: 'PATCH is sent with the new description and the row list reflects it',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Reset Defaults',
      expectedOutcome: 'DELETE is sent for that tool',
      test: () => {},
    },
  ],
};

interface ToolSettingsItem {
  toolId: string;
  name: string;
  description: string;
  category: 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
  alwaysOn: boolean;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: string | null;
  enabled: boolean;
  defaultInclude: { chat: boolean; subAgent: boolean; autonomous: boolean };
  instructions: string;
}

function tool(overrides: Partial<ToolSettingsItem>): ToolSettingsItem {
  return {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'Fetch and summarize the contents of a URL.',
    category: 'built-in',
    alwaysOn: false,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
    enabled: true,
    defaultInclude: { chat: true, subAgent: false, autonomous: true },
    instructions: '',
    ...overrides,
  };
}

const INITIAL_TOOLS: ToolSettingsItem[] = [
  tool({ toolId: 'web_fetch', name: 'Web Fetch' }),
  tool({
    toolId: 'wiki_search',
    name: 'Wiki Search',
    category: 'wiki',
    alwaysOn: true,
    description: 'Full-text search over the wiki.',
  }),
];

// Same "mock only this feature's own endpoints" principle as
// settings-mcp-servers.spec.ts — /api/v1/tool-settings is self-contained and
// unrelated to the batched /api/v1/settings/** slugs settings-sections.spec.ts
// mocks, so this file mocks only its own route.
async function mockToolSettingsApi(page: Page, initial: ToolSettingsItem[] = INITIAL_TOOLS) {
  let tools = initial;

  await page.route('**/api/v1/tool-settings**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const method = req.method();

    if (pathname === '/api/v1/tool-settings' && method === 'GET') {
      return route.fulfill({ json: tools });
    }

    const idMatch = pathname.match(/^\/api\/v1\/tool-settings\/([^/]+)$/);
    if (idMatch && method === 'PATCH') {
      const toolId = decodeURIComponent(idMatch[1]);
      const patch = req.postDataJSON() as Partial<ToolSettingsItem>;
      tools = tools.map((t) => (t.toolId === toolId ? { ...t, ...patch } : t));
      return route.fulfill({ json: tools.find((t) => t.toolId === toolId) });
    }
    if (idMatch && method === 'DELETE') {
      const toolId = decodeURIComponent(idMatch[1]);
      tools = tools.map((t) => (t.toolId === toolId ? tool({ toolId, name: t.name }) : t));
      return route.fulfill({ json: tools.find((t) => t.toolId === toolId) });
    }

    await route.fallback();
  });
}

// Rows are `<button data-slot="tool-access-row">` elements themselves (see
// tool-access-table.tsx) — clicking anywhere in the row opens its drawer.
// Scoped by data-slot + name rather than a bare getByText: the description
// column can otherwise contain text overlapping another row's name.
function toolRow(page: Page, name: string) {
  return page.locator('[data-slot="tool-access-row"]', { hasText: name });
}

test.describe('Settings Tools admin drawer', { annotation: suiteAnnotations(suite) }, () => {
  test('Search filters the table by name/description @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockToolSettingsApi(page);
    await page.goto('/settings?section=tools');
    await pauseBeforeAction(page, testInfo);

    await page.getByLabel('Search tools').fill('wiki');

    // Scoped to the row, not a bare getByText: each row's own (closed but
    // still-mounted, per Drawer's usual behavior) admin drawer carries an
    // <h2> title with the same tool name, so an unscoped match is ambiguous
    // the moment more than one row exists.
    await expect(toolRow(page, 'Wiki Search')).toBeVisible();
    await expect(toolRow(page, 'Web Fetch')).not.toBeVisible();
  });

  test("Opening a row pre-fills the drawer with that tool's own settings @user-workflow", async ({
    page,
  }, testInfo) => {
    await mockToolSettingsApi(page);
    await page.goto('/settings?section=tools');
    await pauseBeforeAction(page, testInfo);

    await toolRow(page, 'Web Fetch').click();

    const drawer = page.locator('dialog[open]');
    await expect(drawer.getByLabel('Description')).toHaveValue(
      'Fetch and summarize the contents of a URL.',
    );
    await expect(drawer.getByLabel('Enable Web Fetch')).toBeVisible();
  });

  test('alwaysOn tools show a locked "Always on" state instead of the Enabled switch @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockToolSettingsApi(page);
    await page.goto('/settings?section=tools');
    await pauseBeforeAction(page, testInfo);

    await toolRow(page, 'Wiki Search').click();

    const drawer = page.locator('dialog[open]');
    await expect(drawer.getByText('Always on')).toBeVisible();
    await expect(drawer.getByLabel('Enable Wiki Search')).not.toBeVisible();
  });

  test('Save sends a PATCH with the edited description @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockToolSettingsApi(page);
    await page.goto('/settings?section=tools');
    await pauseBeforeAction(page, testInfo);

    await toolRow(page, 'Web Fetch').click();
    const drawer = page.locator('dialog[open]');
    await drawer.getByLabel('Description').fill('Custom description');

    const [patchRequest] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('/api/v1/tool-settings/web_fetch') && req.method() === 'PATCH',
      ),
      drawer.getByRole('button', { name: 'Save' }).click(),
    ]);
    expect((patchRequest.postDataJSON() as { description?: string }).description).toBe(
      'Custom description',
    );
  });

  test('Reset Defaults sends a DELETE for that tool @user-workflow', async ({ page }, testInfo) => {
    await mockToolSettingsApi(page);
    await page.goto('/settings?section=tools');
    await pauseBeforeAction(page, testInfo);

    await toolRow(page, 'Web Fetch').click();
    const drawer = page.locator('dialog[open]');

    const [deleteRequest] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('/api/v1/tool-settings/web_fetch') && req.method() === 'DELETE',
      ),
      drawer.getByRole('button', { name: 'Reset Defaults' }).click(),
    ]);
    expect(deleteRequest.method()).toBe('DELETE');
  });
});
