import { test, expect, type Page } from '@playwright/test';
import { suiteAnnotations, type TestSuite } from '../lib/suite.js';
import { pauseBeforeAction } from '../lib/video.js';

const suite: TestSuite = {
  id: 28,
  name: 'Chat Edit Tools drawer',
  description:
    'Verifies the per-thread "Edit Tools" drawer reachable from the chat window + menu: viewing Built-in/Assigned/Available sections, adding/removing, and saving a thread\'s tool selection',
  purpose:
    'Ensure users can control which tools are available to a given conversation (issue #171) without depending on real MCP servers or a live LLM turn',
  tags: ['@functional', '@user-workflow'],
  steps: [
    {
      tags: ['@user-workflow'],
      action: 'Open "Add to message" and click "Edit tools"',
      expectedOutcome: 'The drawer opens and lists tools in Built-in/Assigned/Available sections',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'A globally-disabled tool is not shown',
      expectedOutcome: 'It does not appear in any section',
      test: () => {},
    },
    {
      tags: ['@user-workflow'],
      action: 'Click "+ Add" on an Available tool and click Save',
      expectedOutcome: 'PUT is sent with the full resulting selection',
      test: () => {},
    },
  ],
};

interface ThreadToolItem {
  toolId: string;
  name: string;
  description: string;
  category: 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
  alwaysOn: boolean;
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
    alwaysOn: false,
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
  tool({
    toolId: 'wiki_search',
    name: 'Wiki Search',
    category: 'wiki',
    alwaysOn: true,
    selected: true,
  }),
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
  test('opens from the + menu and lists tools in Built-in/Assigned/Available @user-workflow', async ({
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

  test('a globally-disabled tool does not appear in any section @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockThreadToolsApi(page);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await page.locator('button[aria-label="Add to message"]').click();
    await page.getByRole('menuitem', { name: 'Edit tools' }).click();

    const drawer = page.locator('dialog[open]');
    await expect(drawer.getByText('Web Fetch')).toBeVisible();
    await expect(drawer.getByText('Search Skills')).not.toBeVisible();
  });

  test('+ Add then Save sends the full resulting selection @user-workflow', async ({
    page,
  }, testInfo) => {
    await mockThreadToolsApi(page);
    await page.goto('/');
    await pauseBeforeAction(page, testInfo);

    await page.locator('button[aria-label="Add to message"]').click();
    await page.getByRole('menuitem', { name: 'Edit tools' }).click();

    const drawer = page.locator('dialog[open]');
    await drawer
      .locator('[data-slot="thread-tool-row"]', { hasText: 'Shell Exec' })
      .getByRole('button', { name: '+ Add' })
      .click();

    const [putRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/tools') && req.method() === 'PUT'),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);
    const body = putRequest.postDataJSON() as { toolIds: string[] };
    expect(new Set(body.toolIds)).toEqual(new Set(['web_fetch', 'shell_exec']));
  });
});
