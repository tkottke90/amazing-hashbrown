import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import { createToolAccessMiddleware } from './tool-access.middleware.js';
import { createMcpToolDiscoveryMiddleware } from './mcp-tool-discovery.middleware.js';
import type { ToolEntry } from '../config/env.js';

function fakeTool(name: string): ClientTool {
  return { name } as unknown as ClientTool;
}

function useMcpToolsTurn(toolCallId: string, accepted: string[]): BaseMessage[] {
  return [
    new HumanMessage('do the n8n thing'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: toolCallId, name: 'use_mcp_tools', args: { toolIds: accepted } }],
    }),
    new ToolMessage({
      content: JSON.stringify({ accepted, rejected: [] }),
      tool_call_id: toolCallId,
      name: 'use_mcp_tools',
    }),
  ];
}

interface FakeRequest {
  tools: ClientTool[];
  messages: BaseMessage[];
}

async function runMiddleware(
  middleware: ReturnType<typeof createMcpToolDiscoveryMiddleware>,
  request: FakeRequest,
): Promise<{ tools: string[]; sameReference: boolean }> {
  let seenTools: string[] = [];
  let sameReference = false;
  const handler = async (req: { tools: ClientTool[] }) => {
    seenTools = req.tools.map((t) => t.name as string);
    sameReference = req.tools === request.tools;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return undefined as any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (middleware as any).wrapModelCall(request, handler);
  return { tools: seenTools, sameReference };
}

describe('agents/mcp-tool-discovery.middleware', () => {
  describe('createMcpToolDiscoveryMiddleware() (unit)', () => {
    const mcpTools = [fakeTool('n8n__workflow_search'), fakeTool('n8n__workflow_get')];

    it('passes request.tools through by the same reference when nothing was discovered this turn', async () => {
      const middleware = createMcpToolDiscoveryMiddleware(mcpTools);
      const request: FakeRequest = {
        tools: [fakeTool('search_mcp_tools')],
        messages: [new HumanMessage('hello'), new AIMessage('hi')],
      };
      const { tools, sameReference } = await runMiddleware(middleware, request);
      expect(tools).to.deep.equal(['search_mcp_tools']);
      expect(sameReference).to.equal(true);
    });

    it('adds a discovered MCP tool that is not currently in request.tools', async () => {
      const middleware = createMcpToolDiscoveryMiddleware(mcpTools);
      const request: FakeRequest = {
        tools: [fakeTool('search_mcp_tools')],
        messages: useMcpToolsTurn('c1', ['n8n:workflow_search']),
      };
      const { tools } = await runMiddleware(middleware, request);
      expect(tools).to.include.members(['search_mcp_tools', 'n8n__workflow_search']);
    });

    it('does not duplicate a discovered tool that is already in request.tools', async () => {
      const middleware = createMcpToolDiscoveryMiddleware(mcpTools);
      const request: FakeRequest = {
        tools: [fakeTool('search_mcp_tools'), fakeTool('n8n__workflow_search')],
        messages: useMcpToolsTurn('c1', ['n8n:workflow_search']),
      };
      const { tools } = await runMiddleware(middleware, request);
      expect(tools.filter((n) => n === 'n8n__workflow_search')).to.have.lengthOf(1);
    });

    it('silently ignores a discovered id with no matching candidate tool', async () => {
      const middleware = createMcpToolDiscoveryMiddleware(mcpTools);
      const request: FakeRequest = {
        tools: [fakeTool('search_mcp_tools')],
        messages: useMcpToolsTurn('c1', ['some-removed-server:removed_tool']),
      };
      const { tools } = await runMiddleware(middleware, request);
      expect(tools).to.deep.equal(['search_mcp_tools']);
    });
  });

  describe('orchestration: chained with toolAccessMiddleware (real stores)', () => {
    let dir: string;
    let db: SqliteDatabase;
    let toolsConfig: Record<string, ToolEntry>;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'mcp-tool-discovery-middleware-test-'));
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

    async function runChained(messages: BaseMessage[]): Promise<string[]> {
      const toolAccess = createToolAccessMiddleware(() => toolsConfig);
      const discovery = createMcpToolDiscoveryMiddleware([fakeTool('n8n__workflow_search')]);
      const request = {
        tools: [fakeTool('search_mcp_tools'), fakeTool('n8n__workflow_search')],
        messages,
        runtime: { configurable: { thread_id: 't1' } },
        systemMessage: { content: 'base prompt' },
        state: { requestedToolIds: [] },
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
        return (discovery as any).wrapModelCall(reqAfterToolAccess, finalHandler);
      });
      return seenTools;
    }

    it('a non-customized MCP tool is absent by default (the new category-aware default)', async () => {
      const tools = await runChained([new HumanMessage('hello'), new AIMessage('hi')]);
      expect(tools).to.include('search_mcp_tools');
      expect(tools).to.not.include('n8n__workflow_search');
    });

    it('a Discovered MCP tool becomes present once use_mcp_tools has granted it this turn', async () => {
      const tools = await runChained(useMcpToolsTurn('c1', ['n8n:workflow_search']));
      expect(tools).to.include.members(['search_mcp_tools', 'n8n__workflow_search']);
    });
  });
});
