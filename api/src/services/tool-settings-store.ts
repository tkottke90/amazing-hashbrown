import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';
import type { CatalogEntry } from '../agents/tool-catalog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolSettingCategory = 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
export type McpToolStatus = 'connected' | 'unreachable';

// Pure identity/discovery cache — enabled/defaultInclude/description-override/
// instructions all moved to config.yaml (tools.<toolId>, see
// api/src/agents/tool-config.ts) as of the 2026-09-13 redesign. This table's
// job now is just: which tools exist, and (for MCP tools) their as-discovered
// name/description and connection status.
export interface ToolSettingRow {
  toolId: string;
  name: string;
  description: string;
  category: ToolSettingCategory;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: McpToolStatus | null;
  updatedAt: string;
}

interface RawToolSettingRow {
  tool_id: string;
  name: string;
  description: string;
  category: ToolSettingCategory;
  mcp_server: string | null;
  last_seen_at: string | null;
  last_status: McpToolStatus | null;
  updated_at: string;
}

function mapRow(row: RawToolSettingRow): ToolSettingRow {
  return {
    toolId: row.tool_id,
    name: row.name,
    description: row.description,
    category: row.category,
    mcpServer: row.mcp_server,
    lastSeenAt: row.last_seen_at,
    lastStatus: row.last_status,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// DDL migrations
// ---------------------------------------------------------------------------

// Version numbers must be unique across ALL stores sharing this database —
// see thread-store.ts's own comment for the full running tally. This store
// claims versions 28 (original tables) and 30 (drops enabled/default_include —
// moved to config.yaml, see api/src/agents/tool-config.ts). Version 29
// (threads.tools_customized_at) belongs to thread-store.ts, not this store.
const MIGRATIONS: DbMigration[] = [
  {
    version: 28,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_settings (
        tool_id          TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL,
        category         TEXT NOT NULL,
        enabled          INTEGER NOT NULL,
        default_include  INTEGER NOT NULL,
        mcp_server       TEXT,
        last_seen_at     TEXT,
        last_status      TEXT,
        updated_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_tools (
        thread_id  TEXT NOT NULL,
        tool_id    TEXT NOT NULL REFERENCES tool_settings(tool_id) ON DELETE CASCADE,
        PRIMARY KEY (thread_id, tool_id)
      );
    `,
  },
  {
    // enabled/default_include now live in config.yaml (tools.<toolId>) —
    // this table is a pure MCP-discovery cache from here on. Also truncates
    // every existing MCP row outright: their primary key shape changes from
    // bare tool name to the server-qualified display id
    // (<serverSlug>:<toolName>, see @tkottke90/tools-manager's
    // mcpDisplayId), so an in-place rename isn't meaningful — the next
    // discovery/refresh repopulates them under the new id. This cascades
    // (ON DELETE CASCADE) to any thread_tools rows selecting those old-id
    // MCP tools specifically; a previously-customized thread's other
    // selections and its tools_customized_at flag are untouched. Built-in/
    // wiki/skill-gated rows are unaffected (their id never had a
    // bare-vs-qualified distinction).
    version: 30,
    sql: `
      DELETE FROM tool_settings WHERE category = 'mcp';
      ALTER TABLE tool_settings DROP COLUMN enabled;
      ALTER TABLE tool_settings DROP COLUMN default_include;
    `,
  },
];

// ---------------------------------------------------------------------------
// ToolSettingsStore
// ---------------------------------------------------------------------------

export class ToolSettingsStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  // -------------------------------------------------------------------------
  // Global settings
  // -------------------------------------------------------------------------

  // Insert-if-missing identity row for every catalog tool (built-in/wiki/
  // skill-gated) — never overwrites an existing row. Still needed even
  // though enabled/defaultInclude moved to config.yaml: thread_tools.tool_id
  // has an ON DELETE CASCADE FK to this table, and a customized thread can
  // select a built-in tool, not just an MCP one — dropping catalog rows
  // entirely would break that FK for every non-MCP selection. MCP tools are
  // NOT seeded here — they only get a row once actually discovered, via
  // recordMcpDiscoveryResult().
  seedCatalogDefaults(catalog: CatalogEntry[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tool_settings
         (tool_id, name, description, category, mcp_server, last_seen_at, last_status, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    );
    const seedAll = this.db.transaction((entries: CatalogEntry[]) => {
      for (const entry of entries) {
        insert.run(entry.toolId, entry.name, entry.description, entry.category, now);
      }
    });
    seedAll(catalog);
  }

  list(): ToolSettingRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM tool_settings ORDER BY category, tool_id`)
      .all() as RawToolSettingRow[];
    return rows.map(mapRow);
  }

  getToolSetting(toolId: string): ToolSettingRow | null {
    const row = this.db.prepare(`SELECT * FROM tool_settings WHERE tool_id = ?`).get(toolId) as
      RawToolSettingRow | undefined;
    return row ? mapRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // MCP discovery write-through
  // -------------------------------------------------------------------------

  // Called after a live MCP fetch (lib/tools-manager's fetchAllMcpTools,
  // wrapped by ToolsManager.getMcpServerStatuses()/list()) with every tool
  // returned by a *connected* server and the connected/unreachable outcome
  // per server. A server's own tools are only ever inserted (new rows) or
  // status-updated here — never removed — even when that server currently
  // reports zero tools or is unreachable, so a user's enabled/defaultInclude
  // choice and the tool's identity in the master list both survive the
  // server going down (design §2/§Known limitations).
  // toolId is precomputed by the caller (mcp-tool-status.ts, via
  // @tkottke90/tools-manager's mcpDisplayId) — this store just persists
  // whatever identity it's given; naming-scheme logic doesn't belong here.
  recordMcpDiscoveryResult(
    tools: { toolId: string; name: string; description: string; mcpServer: string }[],
    statuses: Map<string, McpToolStatus>,
  ): void {
    const now = new Date().toISOString();
    const insertIfMissing = this.db.prepare(
      `INSERT OR IGNORE INTO tool_settings
         (tool_id, name, description, category, mcp_server, last_seen_at, last_status, updated_at)
       VALUES (?, ?, ?, 'mcp', ?, ?, 'connected', ?)`,
    );
    // last_seen_at is only ever bumped on success, never blanket-overwritten —
    // it must keep reading "the last time this tool was actually reachable",
    // not "the last time we checked" (design §2).
    const markConnected = this.db.prepare(
      `UPDATE tool_settings SET last_status = 'connected', last_seen_at = ?, updated_at = ?
       WHERE mcp_server = ?`,
    );
    const markUnreachable = this.db.prepare(
      `UPDATE tool_settings SET last_status = 'unreachable', updated_at = ?
       WHERE mcp_server = ?`,
    );

    const applyAll = this.db.transaction(() => {
      for (const [serverName, status] of statuses) {
        if (status === 'connected') {
          for (const tool of tools.filter((t) => t.mcpServer === serverName)) {
            insertIfMissing.run(tool.toolId, tool.name, tool.description, tool.mcpServer, now, now);
          }
          markConnected.run(now, now, serverName);
        } else {
          markUnreachable.run(now, serverName);
        }
      }
    });
    applyAll();
  }

  // Deletes every tool_settings row for a removed MCP server outright — the
  // tools no longer exist at all, as opposed to merely being unreachable.
  // Cascades to thread_tools via ON DELETE CASCADE (design §3).
  deleteMcpServerRows(mcpServer: string): void {
    this.db.prepare(`DELETE FROM tool_settings WHERE mcp_server = ?`).run(mcpServer);
  }

  // -------------------------------------------------------------------------
  // Per-thread selection
  // -------------------------------------------------------------------------

  // A customized thread's raw exact snapshot — unfiltered by "still globally
  // enabled" at this layer, since "enabled" now lives in config.yaml, not
  // this table. Callers (tool-config.ts's consumers) intersect this with
  // getGloballyEnabledToolIds() themselves — a tool disabled globally after
  // the snapshot was taken must still silently drop out (design §3: "global
  // disabled makes it unavailable in all threads"), just computed one layer
  // up now. Meaningless (and not called) for a non-customized thread — see
  // tool-config.ts's getGlobalDefaultToolIds() for that case.
  getThreadToolIds(threadId: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT tool_id FROM thread_tools WHERE thread_id = ?`)
      .all(threadId) as { tool_id: string }[];
    return new Set(rows.map((r) => r.tool_id));
  }

  // Replaces a thread's tool_tools rows with an exact snapshot. Does NOT
  // touch threads.tools_customized_at — the caller (PUT /threads/:id/tools)
  // sets that via ThreadStore.markThreadToolsCustomized() in the same
  // request, since that column lives in a different store's table.
  setThreadTools(threadId: string, toolIds: string[]): void {
    const clear = this.db.prepare(`DELETE FROM thread_tools WHERE thread_id = ?`);
    const insert = this.db.prepare(`INSERT INTO thread_tools (thread_id, tool_id) VALUES (?, ?)`);
    const replace = this.db.transaction((ids: string[]) => {
      clear.run(threadId);
      for (const toolId of ids) insert.run(threadId, toolId);
    });
    replace(toolIds);
  }

  // Clears a thread's thread_tools rows. Does NOT touch
  // threads.tools_customized_at — paired with
  // ThreadStore.resetThreadToolsCustomization() by the caller.
  resetThreadTools(threadId: string): void {
    this.db.prepare(`DELETE FROM thread_tools WHERE thread_id = ?`).run(threadId);
  }
}

// ---------------------------------------------------------------------------
// Boot wiring — mirrors thread-store.ts
// ---------------------------------------------------------------------------

let _store: ToolSettingsStore | null = null;

export function bootToolSettingsStore(db: SqliteDatabase): void {
  _store = new ToolSettingsStore(db);
  logger.info('Tool settings store opened');
}

export function getToolSettingsStore(): ToolSettingsStore {
  if (!_store) {
    throw new Error('Tool settings store not initialised — call bootToolSettingsStore() first');
  }
  return _store;
}
