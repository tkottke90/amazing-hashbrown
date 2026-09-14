import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SystemMessage } from '@langchain/core/messages';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { createToolAccessMiddleware } from './tool-access.middleware.js';
import type { ToolEntry } from '../config/env.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeTool(name: string): any {
  return { name };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRequest(toolNames: string[], threadId?: string, systemText = 'base prompt'): any {
  return {
    tools: toolNames.map(fakeTool),
    runtime: { configurable: threadId ? { thread_id: threadId } : {} },
    systemMessage: new SystemMessage(systemText),
  };
}

interface RunResult {
  tools: string[];
  systemContent: string;
}

async function runMiddleware(
  middleware: ReturnType<typeof createToolAccessMiddleware>,
  request: unknown,
): Promise<RunResult> {
  let result: RunResult = { tools: [], systemContent: '' };
  const handler = async (req: {
    tools: { name: string }[];
    systemMessage: { content: unknown };
  }) => {
    result = {
      tools: req.tools.map((t) => t.name),
      systemContent: req.systemMessage.content as string,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return undefined as any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (middleware as any).wrapModelCall(request, handler);
  return result;
}

describe('agents/tool-access.middleware', () => {
  let dir: string;
  let db: SqliteDatabase;
  let toolsConfig: Record<string, ToolEntry>;
  let middleware: ReturnType<typeof createToolAccessMiddleware>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-access-middleware-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    bootToolSettingsStore(db);
    getToolSettingsStore().seedCatalogDefaults(TOOL_CATALOG);
    getThreadStore().upsertThreadOnFirstMessage('t1', 'hi');
    getThreadStore().upsertThreadOnFirstMessage('t2', 'hi');
    toolsConfig = {};
    middleware = createToolAccessMiddleware(() => toolsConfig);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes every tool through unfiltered when there is no thread id', async () => {
    const { tools } = await runMiddleware(middleware, fakeRequest(['web_fetch', 'wiki_search']));
    expect(tools).to.deep.equal(['web_fetch', 'wiki_search']);
  });

  it('always-on wiki tools pass through regardless of settings', async () => {
    const { tools } = await runMiddleware(
      middleware,
      fakeRequest(['wiki_search', 'wiki_create_page'], 't1'),
    );
    expect(tools).to.include.members(['wiki_search', 'wiki_create_page']);
  });

  it('always-on complete_task passes through even for a non-customized thread', async () => {
    const { tools } = await runMiddleware(middleware, fakeRequest(['complete_task'], 't1'));
    expect(tools).to.deep.equal(['complete_task']);
  });

  it('a globally-disabled built-in tool is filtered out even though nothing thread-specific changed', async () => {
    toolsConfig['shell_exec'] = { enabled: false };
    const { tools } = await runMiddleware(
      middleware,
      fakeRequest(['web_fetch', 'shell_exec'], 't1'),
    );
    expect(tools).to.deep.equal(['web_fetch']);
  });

  it('a globally-enabled tool the thread has not selected is filtered out once the thread is customized', async () => {
    getToolSettingsStore().setThreadTools('t1', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t1');
    const { tools } = await runMiddleware(
      middleware,
      fakeRequest(['web_fetch', 'shell_exec'], 't1'),
    );
    expect(tools).to.deep.equal(['shell_exec']);
  });

  it("does not bleed one thread's customization into another thread on the same middleware instance", async () => {
    getToolSettingsStore().setThreadTools('t1', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t1');
    // t2 was never customized — it must still see live global defaults,
    // not t1's snapshot. This is the regression test for the agent-cache
    // risk this middleware's design exists to avoid (see its own doc
    // comment): a thread-specific Set baked in at build time would leak
    // across threads sharing a cached agent; reading runtime.configurable
    // fresh per call, as this middleware does, cannot leak that way.
    const seenT1 = await runMiddleware(middleware, fakeRequest(['web_fetch', 'shell_exec'], 't1'));
    const seenT2 = await runMiddleware(middleware, fakeRequest(['web_fetch', 'shell_exec'], 't2'));
    expect(seenT1.tools).to.deep.equal(['shell_exec']);
    expect(seenT2.tools).to.deep.equal(['web_fetch', 'shell_exec']);
  });

  it('a skill-gated tool passes through even for a customized thread that never selected it', async () => {
    // create_workspace has no checkbox in the Edit Tools drawer, so a
    // thread's saved snapshot never contains it — customizing t1 to select
    // only shell_exec must not cause an ACTIVE skill-gated tool (one
    // skillGatedToolsMiddleware already let through this turn, earlier in
    // the real middleware chain) to get wrongly stripped back out here.
    getToolSettingsStore().setThreadTools('t1', ['shell_exec']);
    getThreadStore().markThreadToolsCustomized('t1');
    const { tools } = await runMiddleware(
      middleware,
      fakeRequest(['shell_exec', 'create_workspace'], 't1'),
    );
    expect(tools).to.deep.equal(['shell_exec', 'create_workspace']);
  });

  it('a skill-gated tool passes through for a non-customized thread too', async () => {
    const { tools } = await runMiddleware(middleware, fakeRequest(['create_workspace'], 't1'));
    expect(tools).to.deep.equal(['create_workspace']);
  });

  it('two servers exposing an identically-named tool are correctly disambiguated: enabling one binds only its bound name', async () => {
    getToolSettingsStore().recordMcpDiscoveryResult(
      [
        {
          toolId: 'server-a:browser_click',
          name: 'browser_click',
          description: 'd',
          mcpServer: 'server-a',
        },
        {
          toolId: 'server-b:browser_click',
          name: 'browser_click',
          description: 'd',
          mcpServer: 'server-b',
        },
      ],
      new Map([
        ['server-a', 'connected'],
        ['server-b', 'connected'],
      ]),
    );
    toolsConfig['server-a:browser_click'] = { defaultInclude: { chat: true } };
    toolsConfig['server-b:browser_click'] = { defaultInclude: { chat: false } };
    const { tools } = await runMiddleware(
      middleware,
      fakeRequest(['server-a__browser_click', 'server-b__browser_click'], 't1'),
    );
    expect(tools).to.deep.equal(['server-a__browser_click']);
  });

  describe('instruction injection (issue #154)', () => {
    it('appends a tool_guidance block for a tool that survives the filter and has instructions set', async () => {
      toolsConfig['web_fetch'] = { instructions: 'Always summarize concisely.' };
      const { systemContent } = await runMiddleware(middleware, fakeRequest(['web_fetch'], 't1'));
      expect(systemContent).to.include('<tool_guidance:web_fetch>');
      expect(systemContent).to.include('Always summarize concisely.');
      expect(systemContent).to.include('</tool_guidance>');
      expect(systemContent.startsWith('base prompt')).to.equal(true);
    });

    it('contributes nothing when instructions are unset', async () => {
      const { systemContent } = await runMiddleware(middleware, fakeRequest(['web_fetch'], 't1'));
      expect(systemContent).to.equal('base prompt');
    });

    it('does not inject instructions for a tool that was filtered out', async () => {
      toolsConfig['shell_exec'] = { enabled: false, instructions: 'should never appear' };
      const { systemContent, tools } = await runMiddleware(
        middleware,
        fakeRequest(['web_fetch', 'shell_exec'], 't1'),
      );
      expect(tools).to.deep.equal(['web_fetch']);
      expect(systemContent).to.not.include('should never appear');
    });

    it('uses the display id (not the bound name) in the tag for an MCP tool', async () => {
      getToolSettingsStore().recordMcpDiscoveryResult(
        [
          {
            toolId: 'playwright:browser_click',
            name: 'browser_click',
            description: 'd',
            mcpServer: 'playwright',
          },
        ],
        new Map([['playwright', 'connected']]),
      );
      toolsConfig['playwright:browser_click'] = {
        defaultInclude: { chat: true },
        instructions: 'click carefully',
      };
      const { systemContent } = await runMiddleware(
        middleware,
        fakeRequest(['playwright__browser_click'], 't1'),
      );
      expect(systemContent).to.include('<tool_guidance:playwright:browser_click>');
      expect(systemContent).to.include('click carefully');
    });
  });

  describe('harness section filtering (issue #154)', () => {
    const HARNESS_TEXT =
      '<identity>\nalways here\n</identity>\n\n<web_fetch>\nfetch guidance\n</web_fetch>\n\n<shell_execution>\nshell guidance\n</shell_execution>';

    it("strips a disabled tool's section even when no tool has custom instructions set", async () => {
      // Regression test: wrapModelCall used to early-return before ever
      // touching systemMessage when instructionBlocks was empty — the common
      // case, since per-tool instructions are opt-in and empty by default.
      // That would have silently defeated section-filtering on every call
      // with no custom instructions set, which is most of them.
      toolsConfig['shell_exec'] = { enabled: false };
      const { systemContent } = await runMiddleware(
        middleware,
        fakeRequest(['web_fetch', 'shell_exec'], 't1', HARNESS_TEXT),
      );
      expect(systemContent).to.not.include('<shell_execution>');
      expect(systemContent).to.include('<web_fetch>');
      expect(systemContent).to.include('<identity>');
    });

    it('keeps every section whose tool is enabled', async () => {
      const { systemContent } = await runMiddleware(
        middleware,
        fakeRequest(['web_fetch', 'shell_exec'], 't1', HARNESS_TEXT),
      );
      expect(systemContent).to.include('<web_fetch>');
      expect(systemContent).to.include('<shell_execution>');
    });

    it('filters sections and still appends instruction blocks in the same call', async () => {
      toolsConfig['shell_exec'] = { enabled: false };
      toolsConfig['web_fetch'] = { instructions: 'Always summarize concisely.' };
      const { systemContent } = await runMiddleware(
        middleware,
        fakeRequest(['web_fetch', 'shell_exec'], 't1', HARNESS_TEXT),
      );
      expect(systemContent).to.not.include('<shell_execution>');
      expect(systemContent).to.include('<web_fetch>');
      expect(systemContent).to.include('<tool_guidance:web_fetch>');
      expect(systemContent).to.include('Always summarize concisely.');
    });
  });
});
