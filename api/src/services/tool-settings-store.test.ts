import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { ToolSettingsStore } from './tool-settings-store.js';
import { ThreadStore } from './thread-store.js';
import type { CatalogEntry } from '../agents/tool-catalog.js';

const CATALOG: CatalogEntry[] = [
  { toolId: 'web_fetch', name: 'Web Fetch', description: 'd', category: 'built-in', alwaysOn: false },
  { toolId: 'shell_exec', name: 'Shell Exec', description: 'd', category: 'built-in', alwaysOn: false },
  { toolId: 'wiki_search', name: 'Wiki Search', description: 'd', category: 'wiki', alwaysOn: true },
  {
    toolId: 'create_workspace',
    name: 'Create Workspace',
    description: 'd',
    category: 'skill-gated',
    alwaysOn: false,
    skillCommand: 'create-workspace',
  },
];

function makeDb(): { db: SqliteDatabase; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tool-settings-store-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  return { db, dir };
}

describe('services/tool-settings-store', () => {
  let db: SqliteDatabase;
  let dir: string;
  let store: ToolSettingsStore;

  beforeEach(() => {
    ({ db, dir } = makeDb());
    store = new ToolSettingsStore(db);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('migrations', () => {
    it('creates tool_settings and thread_tools on a fresh db', () => {
      // No throw on construction (above) is most of the assertion; confirm
      // both tables are actually queryable.
      expect(store.list()).to.deep.equal([]);
    });

    it('migrates cleanly against a db that already has a real ThreadStore-created threads table', () => {
      const { db: sharedDb, dir: sharedDir } = makeDb();
      try {
        const threadStore = new ThreadStore(sharedDb);
        threadStore.upsertThreadOnFirstMessage('t1', 'hello');
        // Constructing ToolSettingsStore on the same connection after
        // ThreadStore must not throw or collide on migration versions.
        const toolStore = new ToolSettingsStore(sharedDb);
        expect(toolStore.list()).to.deep.equal([]);
        expect(threadStore.getThreadMeta('t1')!.toolsCustomizedAt).to.equal(null);
      } finally {
        rmSync(sharedDir, { recursive: true, force: true });
      }
    });
  });

  describe('seedCatalogDefaults()', () => {
    it('seeds every catalog entry with enabled/defaultInclude true', () => {
      store.seedCatalogDefaults(CATALOG);
      const rows = store.list();
      expect(rows).to.have.length(4);
      for (const row of rows) {
        expect(row.enabled).to.equal(true);
        expect(row.defaultInclude).to.equal(true);
      }
    });

    it('is idempotent — re-seeding does not duplicate rows or overwrite a customized one', () => {
      store.seedCatalogDefaults(CATALOG);
      store.patch('web_fetch', { enabled: false });
      store.seedCatalogDefaults(CATALOG);
      const rows = store.list();
      expect(rows).to.have.length(4);
      expect(store.getToolSetting('web_fetch')!.enabled).to.equal(false);
    });
  });

  describe('patch()', () => {
    beforeEach(() => store.seedCatalogDefaults(CATALOG));

    it('updates enabled/defaultInclude for a built-in tool', () => {
      const result = store.patch('web_fetch', { enabled: false, defaultInclude: false });
      expect(result).to.not.equal('not-found').and.to.not.equal('not-patchable');
      const row = store.getToolSetting('web_fetch')!;
      expect(row.enabled).to.equal(false);
      expect(row.defaultInclude).to.equal(false);
    });

    it('rejects a wiki tool', () => {
      expect(store.patch('wiki_search', { enabled: false })).to.equal('not-patchable');
      expect(store.getToolSetting('wiki_search')!.enabled).to.equal(true);
    });

    it('rejects a skill-gated tool', () => {
      expect(store.patch('create_workspace', { enabled: false })).to.equal('not-patchable');
    });

    it('returns not-found for an unknown toolId', () => {
      expect(store.patch('nonexistent', { enabled: false })).to.equal('not-found');
    });
  });

  describe('effective-set queries', () => {
    beforeEach(() => store.seedCatalogDefaults(CATALOG));

    it('getGlobalDefaultToolIds() reflects enabled+defaultInclude tools', () => {
      store.patch('shell_exec', { defaultInclude: false });
      const ids = store.getGlobalDefaultToolIds();
      expect(ids.has('web_fetch')).to.equal(true);
      expect(ids.has('shell_exec')).to.equal(false);
    });

    it('getGloballyEnabledToolIds() reflects enabled regardless of defaultInclude', () => {
      store.patch('shell_exec', { enabled: false, defaultInclude: false });
      const ids = store.getGloballyEnabledToolIds();
      expect(ids.has('shell_exec')).to.equal(false);
      expect(ids.has('web_fetch')).to.equal(true);
    });

    it('setThreadTools()/getThreadToolIds() round-trip', () => {
      store.setThreadTools('thread-1', ['web_fetch']);
      expect([...store.getThreadToolIds('thread-1')]).to.deep.equal(['web_fetch']);
    });

    it('getThreadToolIds() excludes a tool that was globally disabled after being selected', () => {
      store.setThreadTools('thread-1', ['web_fetch', 'shell_exec']);
      store.patch('shell_exec', { enabled: false });
      expect([...store.getThreadToolIds('thread-1')]).to.deep.equal(['web_fetch']);
    });

    it('resetThreadTools() clears the snapshot', () => {
      store.setThreadTools('thread-1', ['web_fetch']);
      store.resetThreadTools('thread-1');
      expect([...store.getThreadToolIds('thread-1')]).to.deep.equal([]);
    });
  });

  describe('recordMcpDiscoveryResult()', () => {
    it('inserts new rows for a connected server and marks them connected', () => {
      store.recordMcpDiscoveryResult(
        [{ name: 'pushover_send', description: 'send a pushover notification', mcpServer: 'pushover' }],
        new Map([['pushover', 'connected']]),
      );
      const row = store.getToolSetting('pushover_send')!;
      expect(row.category).to.equal('mcp');
      expect(row.mcpServer).to.equal('pushover');
      expect(row.lastStatus).to.equal('connected');
      expect(row.lastSeenAt).to.not.equal(null);
    });

    it('marks an unreachable server\'s existing tools unreachable without touching lastSeenAt', async () => {
      store.recordMcpDiscoveryResult(
        [{ name: 'pushover_send', description: 'send a pushover notification', mcpServer: 'pushover' }],
        new Map([['pushover', 'connected']]),
      );
      const seenAt = store.getToolSetting('pushover_send')!.lastSeenAt;
      await new Promise((r) => setTimeout(r, 5));
      store.recordMcpDiscoveryResult([], new Map([['pushover', 'unreachable']]));
      const row = store.getToolSetting('pushover_send')!;
      expect(row.lastStatus).to.equal('unreachable');
      expect(row.lastSeenAt).to.equal(seenAt);
    });

    it('does not insert a row for a server it cannot reach and has never seen', () => {
      store.recordMcpDiscoveryResult([], new Map([['never-connected', 'unreachable']]));
      expect(store.list()).to.have.length(0);
    });
  });

  describe('deleteMcpServerRows()', () => {
    it('deletes the server\'s tool_settings rows and cascades to thread_tools', () => {
      store.recordMcpDiscoveryResult(
        [{ name: 'pushover_send', description: 'send a pushover notification', mcpServer: 'pushover' }],
        new Map([['pushover', 'connected']]),
      );
      store.setThreadTools('thread-1', ['pushover_send']);
      store.deleteMcpServerRows('pushover');
      expect(store.getToolSetting('pushover_send')).to.equal(null);
      // Assert directly on the underlying table, not just via the
      // join-based getThreadToolIds() — that getter would read empty
      // either way once tool_settings is gone, so it can't by itself prove
      // ON DELETE CASCADE actually removed the orphaned thread_tools row
      // rather than leaving it dangling.
      const remaining = db
        .prepare(`SELECT * FROM thread_tools WHERE thread_id = ?`)
        .all('thread-1');
      expect(remaining).to.have.length(0);
    });
  });
});
