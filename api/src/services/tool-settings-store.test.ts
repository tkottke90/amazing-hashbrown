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
  {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'd',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'shell_exec',
    name: 'Shell Exec',
    description: 'd',
    category: 'built-in',
    alwaysOn: false,
  },
  {
    toolId: 'wiki_search',
    name: 'Wiki Search',
    description: 'd',
    category: 'wiki',
    alwaysOn: true,
  },
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

    it('a fresh tool_settings table has no enabled/default_include columns (moved to config.yaml)', () => {
      const columns = (
        db.prepare(`PRAGMA table_info(tool_settings)`).all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).to.not.include('enabled');
      expect(columns).to.not.include('default_include');
    });
  });

  describe('seedCatalogDefaults()', () => {
    it('seeds an identity row for every catalog entry', () => {
      store.seedCatalogDefaults(CATALOG);
      const rows = store.list();
      expect(rows).to.have.length(4);
      expect(rows.map((r) => r.toolId).sort()).to.deep.equal([
        'create_workspace',
        'shell_exec',
        'web_fetch',
        'wiki_search',
      ]);
    });

    it('is idempotent — re-seeding does not duplicate or overwrite an existing row', () => {
      store.seedCatalogDefaults(CATALOG);
      const before = store.getToolSetting('web_fetch')!;
      store.seedCatalogDefaults(CATALOG);
      const rows = store.list();
      expect(rows).to.have.length(4);
      expect(store.getToolSetting('web_fetch')).to.deep.equal(before);
    });
  });

  describe('per-thread selection', () => {
    beforeEach(() => store.seedCatalogDefaults(CATALOG));

    it('setThreadTools()/getThreadToolIds() round-trip', () => {
      store.setThreadTools('thread-1', ['web_fetch']);
      expect([...store.getThreadToolIds('thread-1')]).to.deep.equal(['web_fetch']);
    });

    it('getThreadToolIds() returns the raw stored snapshot — enabled-filtering is a caller concern now', () => {
      store.setThreadTools('thread-1', ['web_fetch', 'shell_exec']);
      // No SQL-level enabled filter anymore (that column moved to
      // config.yaml) — both selections come back regardless.
      expect([...store.getThreadToolIds('thread-1')].sort()).to.deep.equal([
        'shell_exec',
        'web_fetch',
      ]);
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
        [
          {
            toolId: 'pushover:pushover_send',
            name: 'pushover_send',
            description: 'send a pushover notification',
            mcpServer: 'pushover',
          },
        ],
        new Map([['pushover', 'connected']]),
      );
      const row = store.getToolSetting('pushover:pushover_send')!;
      expect(row.category).to.equal('mcp');
      expect(row.name).to.equal('pushover_send');
      expect(row.mcpServer).to.equal('pushover');
      expect(row.lastStatus).to.equal('connected');
      expect(row.lastSeenAt).to.not.equal(null);
    });

    it("marks an unreachable server's existing tools unreachable without touching lastSeenAt", async () => {
      store.recordMcpDiscoveryResult(
        [
          {
            toolId: 'pushover:pushover_send',
            name: 'pushover_send',
            description: 'send a pushover notification',
            mcpServer: 'pushover',
          },
        ],
        new Map([['pushover', 'connected']]),
      );
      const seenAt = store.getToolSetting('pushover:pushover_send')!.lastSeenAt;
      await new Promise((r) => setTimeout(r, 5));
      store.recordMcpDiscoveryResult([], new Map([['pushover', 'unreachable']]));
      const row = store.getToolSetting('pushover:pushover_send')!;
      expect(row.lastStatus).to.equal('unreachable');
      expect(row.lastSeenAt).to.equal(seenAt);
    });

    it('does not insert a row for a server it cannot reach and has never seen', () => {
      store.recordMcpDiscoveryResult([], new Map([['never-connected', 'unreachable']]));
      expect(store.list()).to.have.length(0);
    });
  });

  describe('deleteMcpServerRows()', () => {
    it("deletes the server's tool_settings rows and cascades to thread_tools", () => {
      store.recordMcpDiscoveryResult(
        [
          {
            toolId: 'pushover:pushover_send',
            name: 'pushover_send',
            description: 'send a pushover notification',
            mcpServer: 'pushover',
          },
        ],
        new Map([['pushover', 'connected']]),
      );
      store.setThreadTools('thread-1', ['pushover:pushover_send']);
      store.deleteMcpServerRows('pushover');
      expect(store.getToolSetting('pushover:pushover_send')).to.equal(null);
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
