import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import yaml from 'yaml';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { ToolsManager } from '@tkottke90/tools-manager';
import { bootToolSettingsStore } from '../../services/tool-settings-store.js';
import type { CatalogEntry } from '../../agents/tool-catalog.js';
import {
  listToolSettingsHandler,
  patchToolSettingHandler,
  deleteToolSettingHandler,
  refreshToolSettingsHandler,
} from './tool-settings.handlers.js';

// listResolvedToolSettings() (which every handler above calls) reads
// TOOL_CATALOG directly, not an injectable list — these tests only cover
// the two catalog entries relevant to their assertions (web_fetch,
// wiki_search) plus whatever this test's own recordMcpDiscoveryResult()
// calls add, and don't assert on the full catalog's length.

// Same private-field stubbing seam Phase 1's tools-manager.test.ts uses —
// avoids a real MCP connection while still exercising ToolsManager's real
// getMcpServerStatuses()/list() plumbing. Includes a no-op close() since
// ToolsManager.close() (called in afterEach) iterates and closes every
// client in the map.
function stubMcpFetch(
  manager: ToolsManager,
  clients: Map<string, { initializeConnections(): Promise<unknown> }>,
): void {
  for (const client of clients.values()) {
    (client as unknown as Record<string, unknown>)['close'] ??= async () => {};
  }
  (manager as unknown as Record<string, unknown>)['mcpClients'] = clients;
}

describe('routes/v1/tool-settings.handlers', () => {
  let db: SqliteDatabase;
  let dir: string;
  let configDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-settings-handlers-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootToolSettingsStore(db);
    configDir = mkdtempSync(join(tmpdir(), 'tool-settings-handlers-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  describe('listToolSettingsHandler()', () => {
    it('returns every catalog tool, resolved', () => {
      const result = listToolSettingsHandler();
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.map((t) => t.toolId)).to.include.members(['web_fetch', 'wiki_search']);
        const webFetch = result.data.find((t) => t.toolId === 'web_fetch')!;
        expect(webFetch.enabled).to.equal(true);
      }
    });
  });

  describe('patchToolSettingHandler()', () => {
    it('updates a built-in tool and writes it into config.yaml', () => {
      const result = patchToolSettingHandler('web_fetch', { enabled: false }, configDir);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.enabled).to.equal(false);
      const written = yaml.parse(readFileSync(join(configDir, 'config.yaml'), 'utf8'));
      expect(written.tools.web_fetch.enabled).to.equal(false);
    });

    it('400s on a skill-gated tool', () => {
      const result = patchToolSettingHandler('create_workspace', { enabled: false }, configDir);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('400s on enabled/defaultInclude for an alwaysOn tool', () => {
      const result = patchToolSettingHandler('wiki_search', { enabled: false }, configDir);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('allows editing description/instructions on an alwaysOn tool', () => {
      const result = patchToolSettingHandler(
        'wiki_search',
        { instructions: 'be thorough' },
        configDir,
      );
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.instructions).to.equal('be thorough');
    });

    it('404s on an unknown tool', () => {
      const result = patchToolSettingHandler('nonexistent', { enabled: false }, configDir);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it("validates web_fetch's extra fields against its own typed schema", () => {
      const result = patchToolSettingHandler('web_fetch', { timeoutMs: 5000 }, configDir);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data['timeoutMs']).to.equal(5000);
    });

    it('rejects an extra field for a tool with no known extra-field schema', () => {
      const result = patchToolSettingHandler('web_fetch', { notAField: 'x' }, configDir);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('preserves an unrelated tool already stored in config.yaml when patching a different one', () => {
      patchToolSettingHandler('web_fetch', { enabled: false }, configDir);
      patchToolSettingHandler('shell_exec', { enabled: false }, configDir);
      const written = yaml.parse(readFileSync(join(configDir, 'config.yaml'), 'utf8'));
      expect(written.tools.web_fetch.enabled).to.equal(false);
      expect(written.tools.shell_exec.enabled).to.equal(false);
    });

    it('calls the provided reload callback on success', () => {
      let reloaded = 0;
      patchToolSettingHandler('web_fetch', { enabled: false }, configDir, () => {
        reloaded += 1;
      });
      expect(reloaded).to.equal(1);
    });
  });

  describe('deleteToolSettingHandler()', () => {
    it('removes a stored override, reverting the tool to computed defaults', () => {
      patchToolSettingHandler('web_fetch', { enabled: false }, configDir);
      const result = deleteToolSettingHandler('web_fetch', configDir);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.enabled).to.equal(true);
      const written = yaml.parse(readFileSync(join(configDir, 'config.yaml'), 'utf8'));
      expect(written.tools.web_fetch).to.equal(undefined);
    });

    it('404s on an unknown tool', () => {
      const result = deleteToolSettingHandler('nonexistent', configDir);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('refreshToolSettingsHandler()', () => {
    let manager: ToolsManager;
    let mcpDir: string;

    beforeEach(async () => {
      mcpDir = mkdtempSync(join(tmpdir(), 'tool-settings-handlers-mcp-'));
      manager = new ToolsManager({ configDir: mcpDir });
      await manager.boot();
    });

    afterEach(async () => {
      await manager.close();
      rmSync(mcpDir, { recursive: true, force: true });
    });

    it('returns the resolved list unchanged when no MCP servers are configured', async () => {
      const result = await refreshToolSettingsHandler(manager);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.map((t) => t.toolId)).to.not.include('pushover:pushover_send');
      }
    });

    it('writes a newly discovered MCP tool into the store under its display id', async () => {
      stubMcpFetch(
        manager,
        new Map([
          [
            'pushover',
            {
              initializeConnections: async () => ({
                pushover: [
                  {
                    name: 'pushover_send',
                    description: 'send a notification',
                    schema: {},
                    invoke: async () => 'ok',
                  },
                ],
              }),
            },
          ],
        ]),
      );
      const result = await refreshToolSettingsHandler(manager);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const row = result.data.find((t) => t.toolId === 'pushover:pushover_send');
        expect(row).to.not.equal(undefined);
        expect(row!.category).to.equal('mcp');
        expect(row!.lastStatus).to.equal('connected');
      }
    });
  });
});
