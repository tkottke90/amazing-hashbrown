import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { ClientTool } from '@langchain/core/tools';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { createToolAccessMiddleware } from './tool-access.middleware.js';
import { createSkillGatedMcpToolsMiddleware } from './skill-gated-mcp-tools.middleware.js';
import type { ToolEntry } from '../config/env.js';

function fakeTool(name: string): ClientTool {
  return { name } as unknown as ClientTool;
}

// Stands in for SkillsManager.list() — same fixture shape
// skill-gated-tools.middleware.test.ts uses for the built-in half.
function fixtureSkills(entries: { name: string; tools: string }[]) {
  return () => ({ list: () => entries });
}

describe('agents/skill-gated-mcp-tools.middleware', () => {
  let dir: string;
  let db: SqliteDatabase;
  let toolsConfig: Record<string, ToolEntry>;

  // getGloballyEnabledToolIds() (ADR-0071 enforcement) reads the real
  // ToolSettingsStore singleton, so every test here needs a real sqlite
  // temp-dir db — there is no "pure fake" tier the way
  // mcp-tool-discovery.middleware.test.ts has, since that middleware never
  // needed the store at all and this one's whole point is checking it.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-gated-mcp-tools-middleware-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    bootToolSettingsStore(db);
    getToolSettingsStore().seedCatalogDefaults(TOOL_CATALOG);
    getToolSettingsStore().recordMcpDiscoveryResult(
      [
        {
          toolId: 'n8n:workflow_search',
          name: 'workflow_search',
          description: 'Search workflows',
          mcpServer: 'n8n',
        },
      ],
      new Map([['n8n', 'connected']]),
    );
    getThreadStore().upsertThreadOnFirstMessage('t1', 'hi');
    toolsConfig = {};
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const getSkills = fixtureSkills([
    { name: 'n8n-workflow-sync', tools: 'create_workspace,n8n:workflow_search' },
  ]);

  async function runStandalone(
    activeSkill: string | null,
    baseTools: ClientTool[] = [],
  ): Promise<string[]> {
    const middleware = createSkillGatedMcpToolsMiddleware(
      [fakeTool('n8n__workflow_search')],
      getSkills,
      () => toolsConfig,
    );
    const request = {
      tools: baseTools,
      state: { activeSkill },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    let seenTools: string[] = [];
    const handler = async (req: { tools: ClientTool[] }) => {
      seenTools = req.tools.map((t) => t.name as string);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return undefined as any;
    };
    await middleware.wrapModelCall!(request, handler);
    return seenTools;
  }

  it('binds the skill-gated MCP tool while its skill is Active', async () => {
    const tools = await runStandalone('n8n-workflow-sync');
    expect(tools).to.include('n8n__workflow_search');
  });

  it('does not bind it when no skill is Active', async () => {
    const tools = await runStandalone(null);
    expect(tools).to.not.include('n8n__workflow_search');
  });

  it('does not bind it while a different skill is Active', async () => {
    const tools = await runStandalone('some-other-skill');
    expect(tools).to.not.include('n8n__workflow_search');
  });

  it('does not duplicate it if already present in request.tools', async () => {
    const tools = await runStandalone('n8n-workflow-sync', [fakeTool('n8n__workflow_search')]);
    expect(tools.filter((n) => n === 'n8n__workflow_search')).to.have.lengthOf(1);
  });

  it("never binds the built-in half of the skill's declared tools — that is skill-gated-tools.middleware.ts's job", async () => {
    const tools = await runStandalone('n8n-workflow-sync');
    expect(tools).to.not.include('create_workspace');
  });

  it("ADR-0071: an admin's explicit disable still wins, even while the skill is Active", async () => {
    toolsConfig['n8n:workflow_search'] = { enabled: false };
    const tools = await runStandalone('n8n-workflow-sync');
    expect(tools).to.not.include('n8n__workflow_search');
  });

  it('binds the skill-gated MCP tool even though toolAccessMiddleware would otherwise exclude a non-customized MCP tool by default', async () => {
    const toolAccess = createToolAccessMiddleware(() => toolsConfig);
    const gatedMcp = createSkillGatedMcpToolsMiddleware(
      [fakeTool('n8n__workflow_search')],
      getSkills,
      () => toolsConfig,
    );
    const request = {
      tools: [fakeTool('search_mcp_tools')],
      messages: [],
      runtime: { configurable: { thread_id: 't1' } },
      systemMessage: { content: 'base prompt' },
      state: { requestedToolIds: [], activeSkill: 'n8n-workflow-sync' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    let seenTools: string[] = [];
    const finalHandler = async (req: { tools: ClientTool[] }) => {
      seenTools = req.tools.map((t) => t.name as string);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return undefined as any;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (toolAccess as any).wrapModelCall(request, (reqAfterToolAccess: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (gatedMcp as any).wrapModelCall(reqAfterToolAccess, finalHandler);
    });

    expect(seenTools).to.include('n8n__workflow_search');
  });

  it('stays absent after toolAccessMiddleware when the admin has disabled it, even while the skill is Active', async () => {
    toolsConfig['n8n:workflow_search'] = { enabled: false };
    const toolAccess = createToolAccessMiddleware(() => toolsConfig);
    const gatedMcp = createSkillGatedMcpToolsMiddleware(
      [fakeTool('n8n__workflow_search')],
      getSkills,
      () => toolsConfig,
    );
    const request = {
      tools: [fakeTool('search_mcp_tools')],
      messages: [],
      runtime: { configurable: { thread_id: 't1' } },
      systemMessage: { content: 'base prompt' },
      state: { requestedToolIds: [], activeSkill: 'n8n-workflow-sync' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    let seenTools: string[] = [];
    const finalHandler = async (req: { tools: ClientTool[] }) => {
      seenTools = req.tools.map((t) => t.name as string);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return undefined as any;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (toolAccess as any).wrapModelCall(request, (reqAfterToolAccess: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (gatedMcp as any).wrapModelCall(reqAfterToolAccess, finalHandler);
    });

    expect(seenTools).to.not.include('n8n__workflow_search');
  });
});
