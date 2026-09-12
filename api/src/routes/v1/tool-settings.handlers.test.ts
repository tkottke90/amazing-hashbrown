import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { ToolsManager } from '@tkottke90/tools-manager';
import { ToolSettingsStore } from '../../services/tool-settings-store.js';
import type { CatalogEntry } from '../../agents/tool-catalog.js';
import {
  listToolSettingsHandler,
  patchToolSettingHandler,
  refreshToolSettingsHandler,
} from './tool-settings.handlers.js';

const CATALOG: CatalogEntry[] = [
  { toolId: 'web_fetch', name: 'Web Fetch', description: 'd', category: 'built-in', alwaysOn: false },
  { toolId: 'wiki_search', name: 'Wiki Search', description: 'd', category: 'wiki', alwaysOn: true },
];

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
  let store: ToolSettingsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-settings-handlers-test-'));
    db = openDatabase(join(dir, 'test.db'));
    store = new ToolSettingsStore(db);
    store.seedCatalogDefaults(CATALOG);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('listToolSettingsHandler()', () => {
    it('returns every seeded tool', () => {
      const result = listToolSettingsHandler(store);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.map((t) => t.toolId)).to.include.members(['web_fetch', 'wiki_search']);
    });
  });

  describe('patchToolSettingHandler()', () => {
    it('updates a built-in tool', () => {
      const result = patchToolSettingHandler(store, 'web_fetch', { enabled: false });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.enabled).to.equal(false);
    });

    it('400s on a wiki tool', () => {
      const result = patchToolSettingHandler(store, 'wiki_search', { enabled: false });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('404s on an unknown tool', () => {
      const result = patchToolSettingHandler(store, 'nonexistent', { enabled: false });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('400s when the body has neither field', () => {
      const result = patchToolSettingHandler(store, 'web_fetch', {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
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

    it('returns the current list unchanged when no MCP servers are configured', async () => {
      const result = await refreshToolSettingsHandler(manager, store);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.map((t) => t.toolId)).to.deep.equal(['web_fetch', 'wiki_search']);
    });

    it('writes a newly discovered MCP tool into the store', async () => {
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
      const result = await refreshToolSettingsHandler(manager, store);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const row = result.data.find((t) => t.toolId === 'pushover_send');
        expect(row).to.not.equal(undefined);
        expect(row!.category).to.equal('mcp');
        expect(row!.lastStatus).to.equal('connected');
      }
    });
  });
});
