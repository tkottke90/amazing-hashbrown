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
  listAvailableEnvVarsHandler,
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

    describe('shell_exec env patch validation (issue #189)', () => {
      it('400s on a lowercase env key and names it', () => {
        const result = patchToolSettingHandler(
          'shell_exec',
          { env: { gh_token: '${GH_TOKEN}' } },
          configDir,
        );
        expect(result.ok).to.equal(false);
        if (!result.ok) {
          expect(result.status).to.equal(400);
          expect(result.error).to.include('gh_token');
        }
      });

      it('400s on a plain (non-lookup) value', () => {
        const result = patchToolSettingHandler(
          'shell_exec',
          { env: { GH_TOKEN: 'abc123' } },
          configDir,
        );
        expect(result.ok).to.equal(false);
        if (!result.ok) {
          expect(result.status).to.equal(400);
          expect(result.error).to.include('${VAR}');
        }
      });

      it('400s when the value contains more than the lookup syntax', () => {
        const result = patchToolSettingHandler(
          'shell_exec',
          { env: { GH_TOKEN: 'Bearer ${GH_TOKEN}' } },
          configDir,
        );
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.status).to.equal(400);
      });

      it('400s on a variable that is not set, listing it; succeeds once it is set', () => {
        delete process.env['DOES_NOT_EXIST_XYZ_9'];
        const missing = patchToolSettingHandler(
          'shell_exec',
          { env: { GH_TOKEN: '${DOES_NOT_EXIST_XYZ_9}' } },
          configDir,
        );
        expect(missing.ok).to.equal(false);
        if (!missing.ok) {
          expect(missing.status).to.equal(400);
          expect(missing.error).to.include('DOES_NOT_EXIST_XYZ_9');
        }
        process.env['DOES_NOT_EXIST_XYZ_9'] = 'sentinel-value';
        const present = patchToolSettingHandler(
          'shell_exec',
          { env: { GH_TOKEN: '${DOES_NOT_EXIST_XYZ_9}' } },
          configDir,
        );
        expect(present.ok).to.equal(true);
        delete process.env['DOES_NOT_EXIST_XYZ_9'];
      });

      it('persists a valid env entry to config.yaml and returns it', () => {
        process.env['GH_TOKEN_TEST_VAR'] = 'sentinel-value';
        const result = patchToolSettingHandler(
          'shell_exec',
          { env: { GH_TOKEN: '${GH_TOKEN_TEST_VAR}' } },
          configDir,
        );
        expect(result.ok).to.equal(true);
        if (result.ok) {
          expect((result.data as Record<string, unknown>)['env']).to.deep.equal({
            GH_TOKEN: '${GH_TOKEN_TEST_VAR}',
          });
        }
        const written = yaml.parse(readFileSync(join(configDir, 'config.yaml'), 'utf8'));
        expect(written.tools.shell_exec.env).to.deep.equal({
          GH_TOKEN: '${GH_TOKEN_TEST_VAR}',
        });
        delete process.env['GH_TOKEN_TEST_VAR'];
      });
    });
  });

  describe('env var name listing (issue #189)', () => {
    it('returns sorted uppercase names, filtering out lowercase ones', () => {
      process.env['ZEBRA_TEST_VAR'] = 'zv';
      process.env['ALPHA_TEST_VAR'] = 'av';
      process.env['lowercase_var'] = 'lv';
      try {
        const result = listAvailableEnvVarsHandler();
        expect(result.ok).to.equal(true);
        if (result.ok) {
          const { names } = result.data;
          expect(names).to.include('ZEBRA_TEST_VAR');
          expect(names).to.include('ALPHA_TEST_VAR');
          expect(names).to.not.include('lowercase_var');
          const seeded = names.filter((n) => n === 'ZEBRA_TEST_VAR' || n === 'ALPHA_TEST_VAR');
          expect(seeded).to.deep.equal(['ALPHA_TEST_VAR', 'ZEBRA_TEST_VAR']);
        }
      } finally {
        delete process.env['ZEBRA_TEST_VAR'];
        delete process.env['ALPHA_TEST_VAR'];
        delete process.env['lowercase_var'];
      }
    });

    it('never includes any variable value in the serialized response', () => {
      process.env['SECRET_VALUE_TEST_VAR'] = 'super-secret-sentinel-value';
      try {
        const result = listAvailableEnvVarsHandler();
        expect(result.ok).to.equal(true);
        if (result.ok) {
          const serialized = JSON.stringify(result.data);
          expect(serialized).to.include('SECRET_VALUE_TEST_VAR');
          expect(serialized).to.not.include('super-secret-sentinel-value');
        }
      } finally {
        delete process.env['SECRET_VALUE_TEST_VAR'];
      }
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
