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

// ---- Live backend: Shell Exec env round-trip (issue #220) ------------------
//
// Unlike the mocked suite above, these tests hit the real API: the bug was the
// round-trip itself (GET returned resolved env values, which the next PATCH
// rejected), which a mocked endpoint can't reproduce. Only ${HOME} (always set)
// and a deliberately unset variable are referenced, so nothing depends on how
// the API process was started.

const liveEnvSuite: TestSuite = {
  id: 44,
  name: 'Shell Exec env settings (live API)',
  description:
    'Saves Shell Exec settings against the real API: an allowlist-only save, adding and removing an env row, and a per-row validation error',
  purpose:
    'Issue #220: saving Shell Exec settings failed with an unexplained PATH error because the drawer received resolved env values; users must be able to configure the tool, and must never see a resolved secret',
  tags: ['@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Change only the allowlist and click Save',
      expectedOutcome: 'The save succeeds and a success toast appears',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add an env row referencing ${HOME}, save, reopen the drawer',
      expectedOutcome: 'The row shows the ${HOME} lookup, never the resolved path',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Remove that row, save, reopen the drawer',
      expectedOutcome: 'The row is gone',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Add an env row referencing an unset variable and click Save',
      expectedOutcome: 'The drawer stays open with an error next to that row naming the variable',
      test: () => {},
    },
  ],
};

interface ShellExecSnapshot {
  allowlist?: string[];
  denylist?: string[];
  env?: Record<string, string>;
}

test.describe(
  'Shell Exec env settings (live API)',
  { annotation: suiteAnnotations(liveEnvSuite) },
  () => {
    let snapshot: ShellExecSnapshot;

    test.beforeEach(async ({ page }) => {
      const res = await page.request.get('/api/v1/tool-settings');
      expect(res.ok()).toBe(true);
      const tools = (await res.json()) as Array<ShellExecSnapshot & { toolId: string }>;
      const shell = tools.find((t) => t.toolId === 'shell_exec')!;
      snapshot = { allowlist: shell.allowlist, denylist: shell.denylist, env: shell.env };
    });

    // Restore only what these tests change, via PATCH rather than Reset
    // Defaults — a DELETE would wipe a developer's local shell_exec config
    // when Playwright reuses their running dev server.
    test.afterEach(async ({ page }) => {
      const res = await page.request.patch('/api/v1/tool-settings/shell_exec', {
        data: {
          allowlist: snapshot.allowlist ?? [],
          denylist: snapshot.denylist ?? [],
          env: snapshot.env ?? {},
        },
      });
      expect(res.ok(), await res.text()).toBe(true);
    });

    async function openShellExec(page: Page) {
      await page.goto('/settings?section=tools');
      await toolRow(page, 'Shell Exec').click();
      const drawer = page.locator('dialog[open]');
      await expect(drawer.getByLabel('Allowlist (one glob per line)')).toBeVisible();
      return drawer;
    }

    test('an allowlist-only save succeeds @user-workflow', async ({ page }, testInfo) => {
      const drawer = await openShellExec(page);
      await pauseBeforeAction(page, testInfo);

      await drawer.getByLabel('Allowlist (one glob per line)').fill('gh *\necho *');
      await drawer.getByRole('button', { name: 'Save' }).click();

      await expect(page.getByRole('alert').filter({ hasText: 'Shell Exec updated' })).toBeVisible();
      await expect(drawer).toBeHidden();
    });

    test('an env row keeps its ${VAR} lookup after saving, and can be removed @user-workflow', async ({
      page,
    }, testInfo) => {
      let drawer = await openShellExec(page);
      await pauseBeforeAction(page, testInfo);

      // The add-row's value field (now a CredentialValueField, labeled
      // "Value" — a sibling toggle switches it into/out of env-reference
      // mode) left in literal mode and typed with "${HOME}" directly.
      await drawer.getByLabel('Add variable name').fill('E2E_HOME_220');
      // exact: true — this field's own "source from environment variable"
      // toggle switch carries "Value" as a substring of its own aria-label.
      await drawer.getByLabel('Value', { exact: true }).fill('${HOME}');
      await drawer.getByRole('button', { name: 'Add', exact: true }).click();
      await drawer.getByRole('button', { name: 'Save' }).click();
      await expect(drawer).toBeHidden();

      // Regression for #220: the reopened drawer must show the stored lookup,
      // not HOME's resolved path. Each row's CredentialValueField is now
      // labeled by the variable name itself (not "Value for <NAME>"); "${HOME}"
      // is a pure env reference, so the row renders in env mode — its visible
      // input holds the bare name "HOME", not the full "${HOME}" string.
      drawer = await openShellExec(page);
      await expect(
        drawer.getByRole('switch', { name: 'Source E2E_HOME_220 from an environment variable' }),
      ).toBeChecked();
      const value = drawer.getByLabel('E2E_HOME_220', { exact: true });
      await expect(value).toHaveValue('HOME');

      await drawer
        .getByRole('button', { name: 'Remove environment variable E2E_HOME_220' })
        .click();
      await drawer.getByRole('button', { name: 'Save' }).click();
      await expect(drawer).toBeHidden();

      drawer = await openShellExec(page);
      await expect(drawer.getByLabel('E2E_HOME_220')).toHaveCount(0);
    });

    test('a row referencing an unset variable shows its error in place @user-workflow', async ({
      page,
    }, testInfo) => {
      const drawer = await openShellExec(page);
      await pauseBeforeAction(page, testInfo);

      await drawer.getByLabel('Add variable name').fill('E2E_BAD_220');
      await drawer.getByLabel('Value', { exact: true }).fill('${E2E_UNSET_VAR_220}');
      await drawer.getByRole('button', { name: 'Add', exact: true }).click();
      await drawer.getByRole('button', { name: 'Save' }).click();

      // The row's error renders as a sibling paragraph below its
      // CredentialValueField (not an aria-invalid/aria-describedby pair on
      // the input itself).
      await expect(drawer.getByText(/E2E_UNSET_VAR_220/)).toBeVisible();
      await expect(drawer).toBeVisible();
    });
  },
);
