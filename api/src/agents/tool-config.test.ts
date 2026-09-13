import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootToolSettingsStore, getToolSettingsStore } from '../services/tool-settings-store.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import type { ToolEntry } from '../config/env.js';
import {
  resolveToolSettings,
  listResolvedToolSettings,
  getGlobalDefaultToolIds,
  getGloballyEnabledToolIds,
  getSubAgentToolIds,
  getToolInstructions,
} from './tool-config.js';

const ALWAYS_ON: Parameters<typeof resolveToolSettings>[0] = {
  toolId: 'wiki_search',
  name: 'Wiki Search',
  description: 'd',
  category: 'wiki',
  alwaysOn: true,
  mcpServer: null,
  lastSeenAt: null,
  lastStatus: null,
};

const REGULAR: Parameters<typeof resolveToolSettings>[0] = {
  toolId: 'web_fetch',
  name: 'Web Fetch',
  description: 'd',
  category: 'built-in',
  alwaysOn: false,
  mcpServer: null,
  lastSeenAt: null,
  lastStatus: null,
};

describe('agents/tool-config', () => {
  describe('resolveToolSettings() — pure, no store dependency', () => {
    it('defaults enabled/defaultInclude.chat/autonomous to true, subAgent to false, when nothing is stored', () => {
      // shell_exec, not REGULAR's web_fetch — web_fetch is itself a legacy
      // SUB_AGENT_TOOLS member (see the next test), so it would default
      // subAgent to true and defeat the point of this one.
      const resolved = resolveToolSettings({ ...REGULAR, toolId: 'shell_exec' }, {});
      expect(resolved.enabled).to.equal(true);
      expect(resolved.defaultInclude).to.deep.equal({
        chat: true,
        subAgent: false,
        autonomous: true,
      });
    });

    it('defaults defaultInclude.subAgent to true for a legacy SUB_AGENT_TOOLS member', () => {
      const resolved = resolveToolSettings({ ...REGULAR, toolId: 'wiki_orient' }, {});
      expect(resolved.defaultInclude.subAgent).to.equal(true);
    });

    it('forces enabled/chat/autonomous to true for an alwaysOn tool regardless of stored overrides, but respects a stored subAgent override', () => {
      // subAgent is deliberately exempt from the alwaysOn force — see
      // resolveToolSettings()'s own comment. wiki_search defaults subAgent
      // true (it's a legacy SUB_AGENT_TOOLS member), but an explicit stored
      // `false` here must still win, the same as it would for any tool.
      const toolsConfig: Record<string, ToolEntry> = {
        wiki_search: {
          enabled: false,
          defaultInclude: { chat: false, subAgent: false, autonomous: false },
        },
      };
      const resolved = resolveToolSettings(ALWAYS_ON, toolsConfig);
      expect(resolved.enabled).to.equal(true);
      expect(resolved.defaultInclude).to.deep.equal({
        chat: true,
        subAgent: false,
        autonomous: true,
      });
    });

    it('an alwaysOn tool not in the legacy SUB_AGENT_TOOLS list defaults subAgent to false even though chat/autonomous are forced true', () => {
      // wiki_create_page: alwaysOn (wiki tools can't be hidden from chat),
      // but a mutating tool the pre-redesign hardcoded allowlist never
      // exposed to a sub-agent. Nothing stored — this is the pure default.
      const resolved = resolveToolSettings(
        { ...ALWAYS_ON, toolId: 'wiki_create_page', name: 'Wiki Create Page' },
        {},
      );
      expect(resolved.defaultInclude).to.deep.equal({
        chat: true,
        subAgent: false,
        autonomous: true,
      });
    });

    it('applies a stored override on top of computed defaults', () => {
      const toolsConfig: Record<string, ToolEntry> = {
        web_fetch: { enabled: false, description: 'custom', instructions: 'be careful' },
      };
      const resolved = resolveToolSettings(REGULAR, toolsConfig);
      expect(resolved.enabled).to.equal(false);
      expect(resolved.description).to.equal('custom');
      expect(resolved.instructions).to.equal('be careful');
      // Untouched fields still fall back to computed defaults.
      expect(resolved.defaultInclude.chat).to.equal(true);
    });

    it('carries tool-specific extra fields through untouched', () => {
      const toolsConfig: Record<string, ToolEntry> = {
        web_fetch: { timeoutMs: 5000, respectRobotsTxt: false },
      };
      const resolved = resolveToolSettings(REGULAR, toolsConfig);
      expect(resolved['timeoutMs']).to.equal(5000);
      expect(resolved['respectRobotsTxt']).to.equal(false);
    });
  });

  describe('store-backed queries (real SQLite for the MCP half)', () => {
    let db: SqliteDatabase;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tool-config-test-'));
      db = openDatabase(join(dir, 'test.db'));
      bootToolSettingsStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    // Regression test: production always calls seedCatalogDefaults() at
    // boot (see index.ts), which inserts an identity row per catalog tool
    // into the SAME tool_settings table store.list() reads from. Without
    // filtering those rows out, listResolvedToolSettings() mapped every one
    // of them through mcpDefaultsFor() (which hardcodes category: 'mcp'),
    // producing a second, fake "MCP" entry for every built-in/wiki/
    // skill-gated tool — the bug a user reported seeing as double rows in
    // Settings > Tools ("Ask User" listed as both Built-in and MCP).
    it('does not duplicate a catalog tool as a fake MCP row when seedCatalogDefaults() has run', () => {
      getToolSettingsStore().seedCatalogDefaults(TOOL_CATALOG);
      const items = listResolvedToolSettings({});
      const askUserRows = items.filter((t) => t.toolId === 'ask_user');
      expect(askUserRows).to.have.length(1);
      expect(askUserRows[0]?.category).to.equal('built-in');
      expect(items.filter((t) => t.category === 'mcp')).to.have.length(0);
    });

    it('listResolvedToolSettings() merges catalog defaults with an MCP discovery row', () => {
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
      const items = listResolvedToolSettings({});
      const mcpItem = items.find((t) => t.toolId === 'playwright:browser_click');
      expect(mcpItem).to.not.equal(undefined);
      expect(mcpItem!.category).to.equal('mcp');
      expect(mcpItem!.mcpServer).to.equal('playwright');
      expect(mcpItem!.enabled).to.equal(true);
    });

    it('getGlobalDefaultToolIds()/getGloballyEnabledToolIds() reflect config.yaml overrides', () => {
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
      const toolsConfig: Record<string, ToolEntry> = {
        'playwright:browser_click': { defaultInclude: { chat: false } },
      };
      expect(getGloballyEnabledToolIds(toolsConfig).has('playwright:browser_click')).to.equal(true);
      expect(getGlobalDefaultToolIds(toolsConfig).has('playwright:browser_click')).to.equal(false);
    });

    it('getSubAgentToolIds() never includes ask_user/spawn_sub_agent even when forced on', () => {
      const toolsConfig: Record<string, ToolEntry> = {
        ask_user: { defaultInclude: { subAgent: true } },
        spawn_sub_agent: { defaultInclude: { subAgent: true } },
      };
      const ids = getSubAgentToolIds(toolsConfig);
      expect(ids.has('ask_user')).to.equal(false);
      expect(ids.has('spawn_sub_agent')).to.equal(false);
    });

    it('getSubAgentToolIds() includes a tool explicitly opted in', () => {
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
      const toolsConfig: Record<string, ToolEntry> = {
        'playwright:browser_click': { defaultInclude: { subAgent: true } },
      };
      expect(getSubAgentToolIds(toolsConfig).has('playwright:browser_click')).to.equal(true);
    });

    // Reproduces the exact SUB_AGENT_TOOLS membership this file's
    // pre-redesign hardcoded array had — the migration-behavior-preserving
    // guarantee (design §3): an unedited config.yaml must not change any
    // existing sub-agent run's tool set.
    it('reproduces the legacy SUB_AGENT_TOOLS membership by default (unedited config.yaml)', () => {
      const ids = getSubAgentToolIds({});
      const expectedIncluded = [
        'wiki_search',
        'wiki_read_page',
        'wiki_locate',
        'wiki_orient',
        'wiki_lint',
        'web_fetch',
        'get_tool_key',
        'rlm_query',
        'search_skills',
        'search_conversation',
      ];
      for (const id of expectedIncluded) {
        expect(ids.has(id), `expected getSubAgentToolIds() to include ${id}`).to.equal(true);
      }
      // complete_task is deliberately not checked here — it's an alwaysOn
      // catalog tool, so getSubAgentToolIds() legitimately includes it (same
      // as every other context); buildSubAgentAgent adds it explicitly via
      // makeCompleteTaskTool() regardless, so this has no effect on runtime
      // behavior either way.
      const expectedExcluded = [
        'ask_user',
        'shell_exec',
        'spawn_sub_agent',
        'upload_image',
        'wiki_create_page',
        'wiki_update_page',
        'wiki_add_cross_link',
        'wiki_rebaseline_source',
        'wiki_register_domain',
        'create_workspace',
        'create_project',
      ];
      for (const id of expectedExcluded) {
        expect(ids.has(id), `expected getSubAgentToolIds() to exclude ${id}`).to.equal(false);
      }
    });
  });

  describe('getToolInstructions()', () => {
    it('returns empty string when unset', () => {
      expect(getToolInstructions('web_fetch', {})).to.equal('');
    });

    it('returns the stored instructions text', () => {
      const toolsConfig: Record<string, ToolEntry> = { web_fetch: { instructions: 'be careful' } };
      expect(getToolInstructions('web_fetch', toolsConfig)).to.equal('be careful');
    });
  });
});
