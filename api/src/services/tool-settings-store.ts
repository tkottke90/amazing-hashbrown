import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';
import type { CatalogEntry } from '../agents/tool-catalog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolSettingCategory = 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
export type McpToolStatus = 'connected' | 'unreachable';

export interface ToolSettingRow {
  toolId: string;
  name: string;
  description: string;
  category: ToolSettingCategory;
  enabled: boolean;
  defaultInclude: boolean;
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
  enabled: number;
  default_include: number;
  mcp_server: string | null;
  last_seen_at: string | null;
  last_status: McpToolStatus | null;
  updated_at: string;
}

export type PatchToolSettingResult = 'not-found' | 'not-patchable' | ToolSettingRow;

function mapRow(row: RawToolSettingRow): ToolSettingRow {
  return {
    toolId: row.tool_id,
    name: row.name,
    description: row.description,
    category: row.category,
    enabled: row.enabled === 1,
    defaultInclude: row.default_include === 1,
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
// claims version 28 (threads.tools_customized_at, the companion column this
// feature also needs, is claimed separately as version 29 in
// thread-store.ts — it belongs to the threads table, not this store).
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

  // Insert-if-missing for every catalog tool (built-in/wiki/skill-gated) —
  // never overwrites an existing row, so a tool a user has already toggled
  // (or an already-customized thread's snapshot) survives a re-seed on every
  // boot, including after a code change adds a brand-new catalog entry.
  // MCP tools are NOT seeded here — they only get a row once actually
  // discovered, via recordMcpDiscoveryResult().
  seedCatalogDefaults(catalog: CatalogEntry[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO tool_settings
         (tool_id, name, description, category, enabled, default_include, mcp_server, last_seen_at, last_status, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, NULL, NULL, NULL, ?)`,
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

  // 'not-found' for an unknown toolId, 'not-patchable' for a wiki or
  // skill-gated tool (wiki can never be disabled; skill-gated is read-only —
  // its real availability is governed entirely by skill-gated-tools.middleware.ts,
  // not this table). The route handler maps these to 404/400 respectively.
  patch(
    toolId: string,
    changes: { enabled?: boolean; defaultInclude?: boolean },
  ): PatchToolSettingResult {
    const existing = this.getToolSetting(toolId);
    if (!existing) return 'not-found';
    if (existing.category === 'wiki' || existing.category === 'skill-gated') {
      return 'not-patchable';
    }
    const enabled = changes.enabled ?? existing.enabled;
    const defaultInclude = changes.defaultInclude ?? existing.defaultInclude;
    this.db
      .prepare(
        `UPDATE tool_settings SET enabled = ?, default_include = ?, updated_at = ? WHERE tool_id = ?`,
      )
      .run(enabled ? 1 : 0, defaultInclude ? 1 : 0, new Date().toISOString(), toolId);
    return this.getToolSetting(toolId)!;
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
  recordMcpDiscoveryResult(
    tools: { name: string; description: string; mcpServer: string }[],
    statuses: Map<string, McpToolStatus>,
  ): void {
    const now = new Date().toISOString();
    const insertIfMissing = this.db.prepare(
      `INSERT OR IGNORE INTO tool_settings
         (tool_id, name, description, category, enabled, default_include, mcp_server, last_seen_at, last_status, updated_at)
       VALUES (?, ?, ?, 'mcp', 1, 1, ?, ?, 'connected', ?)`,
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
            insertIfMissing.run(tool.name, tool.name, tool.description, tool.mcpServer, now, now);
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
  // Per-thread effective set
  // -------------------------------------------------------------------------

  // Every currently-enabled, default-included tool. This is the effective
  // set for any thread that has never been customized (threads.tools_customized_at
  // IS NULL) — callers union this with the catalog's alwaysOn tool ids
  // themselves (this store has no dependency on tool-catalog.ts's alwaysOn
  // semantics, only on the enabled/default_include flags it seeds).
  getGlobalDefaultToolIds(): Set<string> {
    const rows = this.db
      .prepare(`SELECT tool_id FROM tool_settings WHERE enabled = 1 AND default_include = 1`)
      .all() as { tool_id: string }[];
    return new Set(rows.map((r) => r.tool_id));
  }

  // Every currently-enabled tool, regardless of default_include — used to
  // validate a thread's PUT payload (design §5: "400 if any toolId is not
  // currently globally enabled").
  getGloballyEnabledToolIds(): Set<string> {
    const rows = this.db.prepare(`SELECT tool_id FROM tool_settings WHERE enabled = 1`).all() as {
      tool_id: string;
    }[];
    return new Set(rows.map((r) => r.tool_id));
  }

  // A customized thread's exact snapshot, filtered to tools still globally
  // enabled (a tool disabled globally after the snapshot was taken silently
  // drops out here, per design §3 — "global disabled makes it unavailable
  // in all threads"). Meaningless (and not called) for a non-customized
  // thread — see getGlobalDefaultToolIds() for that case.
  getThreadToolIds(threadId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT tt.tool_id AS tool_id
         FROM thread_tools tt
         JOIN tool_settings ts ON ts.tool_id = tt.tool_id
         WHERE tt.thread_id = ? AND ts.enabled = 1`,
      )
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
