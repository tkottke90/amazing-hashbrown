import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 27,
  name: 'Settings MCP servers',
  description:
    'Verifies the MCP Servers settings panel: add, list, enable/disable toggle, edit, connection check, and remove',
  purpose:
    'Ensure users can fully manage MCP server configurations from Settings without a live backend or a real MCP server',
  tags: ['@functional', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Add a stdio MCP server via the Add server drawer',
      expectedOutcome: 'The new server appears in the list with its transport badge',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle a server disabled',
      expectedOutcome: 'PATCH is sent with { enabled: false }',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Check on a server row',
      expectedOutcome: 'Status badge shows "Connected — N tools"',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Open the Edit drawer and edit a server’s command',
      expectedOutcome:
        'The drawer auto-fetches and lists the server’s tools/resources; PATCH is sent with the updated command and the row reflects it',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Remove a server',
      expectedOutcome: 'Confirmation dialog appears; accepting removes the row',
      test: () => {},
    },
  ],
};

interface StubServer {
  name: string;
  config: Record<string, unknown>;
}

const CAPABILITIES = {
  tools: [
    { name: 'alpha', description: 'The alpha tool' },
    { name: 'beta', description: 'The beta tool' },
  ],
  resources: [{ uri: 'file:///readme.md', name: 'readme' }],
  resourceTemplates: [],
};

// No real MCP server exists in CI, so every /api/v1/mcp-servers request is
// mocked (not just the connection-test endpoints) — this keeps the test
// deterministic and self-contained rather than depending on the shared
// backend process's filesystem state across parallel workers.
async function mockMcpServersApi(page: Page, initial: StubServer[] = []) {
  let servers: StubServer[] = initial;

  const BASE = '/api/v1/mcp-servers';

  await page.route('**/api/v1/mcp-servers**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const method = req.method();

    if (pathname === BASE && method === 'GET') {
      return route.fulfill({ json: servers });
    }
    if (pathname === BASE && method === 'POST') {
      const body = req.postDataJSON() as { name: string; config: Record<string, unknown> };
      servers = [...servers, { name: body.name, config: body.config }];
      return route.fulfill({ status: 201, json: { name: body.name, config: body.config } });
    }
    if (pathname === `${BASE}/test` && method === 'POST') {
      return route.fulfill({ json: { ok: true, ...CAPABILITIES } });
    }

    const nameTestMatch = pathname.match(new RegExp(`^${BASE}/([^/]+)/test$`));
    if (nameTestMatch && method === 'POST') {
      return route.fulfill({ json: { ok: true, ...CAPABILITIES } });
    }

    const nameMatch = pathname.match(new RegExp(`^${BASE}/([^/]+)$`));
    if (nameMatch && method === 'PATCH') {
      const name = nameMatch[1];
      const patch = req.postDataJSON() as Record<string, unknown>;
      servers = servers.map((s) =>
        s.name === name ? { ...s, config: { ...s.config, ...patch } } : s,
      );
      return route.fulfill({ json: servers.find((s) => s.name === name) });
    }
    if (nameMatch && method === 'DELETE') {
      servers = servers.filter((s) => s.name !== nameMatch[1]);
      return route.fulfill({ status: 204, body: '' });
    }

    await route.fallback();
  });
}

test.describe('Settings MCP servers', { annotation: suiteAnnotations(suite) }, () => {
  test('Add server: appears in the list with its transport badge @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockMcpServersApi(page);
    await page.goto('/settings?section=mcp-servers');
    await pauseBeforeAction(page, testInfo);

    // The drawer's own children stay mounted (opacity-0, not display:none)
    // even while closed, for the open/close slide transition — so the
    // trigger and the form's identically-labeled "Add server" submit
    // button both exist in the DOM at once. Disambiguate by `type`
    // (trigger is type="button", submit is type="submit") rather than by
    // scoping to `dialog[open]`, which only helps once the dialog is open.
    await page.locator('button[type="button"]', { hasText: 'Add server' }).click();
    const addDialog = page.locator('dialog[open]');
    await addDialog.getByLabel('Name').fill('weather');
    await addDialog.getByLabel('Command').fill('node');
    await addDialog.locator('button[type="submit"]', { hasText: 'Add server' }).click();

    // Precise attribute selectors, not getByText: the success toast ('MCP
    // server "weather" added') also contains the name, and the new row's
    // own (still-mounted-but-closed) Edit modal and the Add modal's Select
    // both also display "stdio" as their default transport value.
    await expect(page.locator('[data-slot="mcp-server-row-name"]')).toHaveText('weather');
    await expect(page.locator('[data-slot="mcp-server-row-transport"]')).toHaveText('stdio');
  });

  test('Toggle enabled sends a PATCH with the new value @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockMcpServersApi(page, [
      { name: 'weather', config: { command: 'node', args: [], enabled: true } },
    ]);
    await page.goto('/settings?section=mcp-servers');
    await pauseBeforeAction(page, testInfo);

    const [patchRequest] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('/api/v1/mcp-servers/weather') && req.method() === 'PATCH',
      ),
      page.getByLabel('Enable weather').click(),
    ]);
    expect(patchRequest.postDataJSON()).toEqual({ enabled: false });
  });

  test('Check shows the returned tool count @user-workflow', async ({ page }, testInfo) => {
    await mockMcpServersApi(page, [
      { name: 'weather', config: { command: 'node', args: [], enabled: true } },
    ]);
    await page.goto('/settings?section=mcp-servers');
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText('Connected — 2 tools')).toBeVisible();
  });

  test('Edit updates the server and Remove deletes it after confirmation @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockMcpServersApi(page, [
      { name: 'weather', config: { command: 'node', args: [], enabled: true } },
    ]);
    await page.goto('/settings?section=mcp-servers');
    await pauseBeforeAction(page, testInfo);

    await page.getByRole('button', { name: 'Edit' }).click();
    // Scoped to the open dialog: the Add-server drawer's own (now
    // uniquely-id'd but still simultaneously mounted) Command field would
    // otherwise make this an ambiguous match too.
    const editDialog = page.locator('dialog[open]');
    // Opening Edit renders a side Drawer (inset-y-0), not a centered Modal
    // (inset-0) — and auto-fetches this server's capabilities, listing its
    // tools/resources without a manual "Test connection" click.
    await expect(editDialog).toHaveClass(/inset-y-0/);
    await expect(editDialog.getByText('alpha', { exact: true })).toBeVisible();
    await expect(editDialog.getByText('readme', { exact: true })).toBeVisible();
    await editDialog.getByLabel('Command').fill('python3');
    const [patchRequest] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('/api/v1/mcp-servers/weather') && req.method() === 'PATCH',
      ),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);
    expect((patchRequest.postDataJSON() as { command?: string }).command).toBe('python3');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('No MCP servers configured')).toBeVisible();
  });
});
