import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 28,
  name: 'Chat Edit Tools drawer',
  description:
    'Verifies the per-thread "Edit Tools" drawer reachable from the chat window + menu: viewing, toggling, saving, and resetting a thread\'s tool selection',
  purpose:
    'Ensure users can control which tools are available to a given conversation (issue #171) without depending on real MCP servers or a live LLM turn',
  tags: ['@functional', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Open "Add to message" and click "Edit tools"',
      expectedOutcome: 'The drawer opens and lists tools grouped by category',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'A globally-disabled tool is shown greyed out',
      expectedOutcome: 'Its checkbox is disabled and unchecked',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Toggle a tool on and click Save',
      expectedOutcome: 'PUT is sent with the full resulting selection',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click Reset to defaults',
      expectedOutcome: 'DELETE is sent and the thread reverts to tracking global defaults',
      test: () => {},
    },
  ],
};

interface ThreadToolItem {
  toolId: string;
  name: string;
  description: string;
  category: 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
  enabled: boolean;
  defaultInclude: boolean;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: string | null;
  updatedAt: string;
  selected: boolean;
}

function tool(overrides: Partial<ThreadToolItem>): ThreadToolItem {
  return {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'Fetch and summarize a URL.',
    category: 'built-in',
    enabled: true,
    defaultInclude: true,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    selected: true,
    ...overrides,
  };
}

const INITIAL_TOOLS: ThreadToolItem[] = [
  tool({ toolId: 'web_fetch', name: 'Web Fetch', selected: true }),
  tool({ toolId: 'shell_exec', name: 'Shell Exec', selected: false }),
  tool({
    toolId: 'search_skills',
    name: 'Search Skills',
    enabled: false,
    defaultInclude: false,
    selected: false,
  }),
  tool({ toolId: 'wiki_search', name: 'Wiki Search', category: 'wiki', selected: true }),
];

// Only the per-thread tool endpoints are mocked — everything else on the
// chat page (thread bootstrap, providers, etc.) hits the real dev backend
// normally, same "mock only what needs determinism" principle
// settings-mcp-servers.spec.ts uses for MCP connections. activeThreadId is
// a client-generated UUID present from page load (ui/src/hooks/use-thread.ts),
// so the "Edit tools" menu item and its drawer work before any message is
// ever sent — no real chat turn is needed to exercise this feature.
async function mockThreadToolsApi(page: Page) {
  let customized = false;
  let tools = INITIAL_TOOLS;

  await page.route('**/api/v1/threads/*/tools**', async (route) => {
    const method = route.request().method();

    if (method === 'GET') {
      return route.fulfill({ json: { customized, tools } });
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as { toolIds: string[] };
      tools = tools.map((t) => ({ ...t, selected: body.toolIds.includes(t.toolId) }));
      customized = true;
      return route.fulfill({ json: { customized, tools } });
    }
    if (method === 'DELETE') {
      customized = false;
      tools = INITIAL_TOOLS;
      return route.fulfill({ json: { customized, tools } });
    }

    await route.fallback();
  });
}

test.describe('Chat Edit Tools drawer', { annotation: suiteAnnotations(suite) }, () => {
  test('opens from the + menu and lists tools by category @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockThreadToolsApi(page);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await page.locator('button[aria-label="Add to message"]').click();
    await page.getByRole('menuitem', { name: 'Edit tools' }).click();

    const drawer = page.locator('dialog[open]');
    await expect(drawer.getByText('Web Fetch')).toBeVisible();
    await expect(drawer.getByText('Shell Exec')).toBeVisible();
    await expect(drawer.getByText('Wiki Search')).toBeVisible();
    await expect(drawer.getByText('Always on')).toBeVisible();
  });

  test('a globally-disabled tool is greyed out and unselectable @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockThreadToolsApi(page);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await page.locator('button[aria-label="Add to message"]').click();
    await page.getByRole('menuitem', { name: 'Edit tools' }).click();

    const checkbox = page.getByLabel('Include Search Skills');
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).not.toBeChecked();
  });

  test('Save sends the full resulting selection @user-workflow', async ({ page }, testInfo) => {
    await mockThreadToolsApi(page);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await page.locator('button[aria-label="Add to message"]').click();
    await page.getByRole('menuitem', { name: 'Edit tools' }).click();

    await page.getByLabel('Include Shell Exec').check();

    const [putRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/tools') && req.method() === 'PUT'),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);
    const body = putRequest.postDataJSON() as { toolIds: string[] };
    expect(new Set(body.toolIds)).toEqual(new Set(['web_fetch', 'shell_exec']));
  });

  test('Reset to defaults sends a DELETE @user-workflow', async ({ page }, testInfo) => {
    await mockThreadToolsApi(page);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await page.locator('button[aria-label="Add to message"]').click();
    await page.getByRole('menuitem', { name: 'Edit tools' }).click();

    const [deleteRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/tools') && req.method() === 'DELETE'),
      page.getByRole('button', { name: 'Reset to defaults' }).click(),
    ]);
    expect(deleteRequest.method()).toBe('DELETE');
  });
});
