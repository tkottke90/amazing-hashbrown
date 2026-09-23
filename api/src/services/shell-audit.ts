import { randomUUID } from 'node:crypto';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import type { AuditEntry, AuditWriter } from '@tkottke90/shell-executor';
import { classifyShellCommand } from './shell-command-classifier.js';

// Version numbers must be unique across ALL features sharing this database
// (see BaseStore's migration doc) — 32 was the next free number as of the
// second migration below (ObservabilityStore: 1,5,7,9; CostStore: 2;
// EvaluationsStore: 3,6,8; thread-store: 4,10-16,29; tool-settings-store:
// 28,30; workspace-store: 18-27; friction-store: 31).
const MIGRATIONS: DbMigration[] = [
  {
    version: 17,
    sql: `
      CREATE TABLE IF NOT EXISTS shell_audit_log (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        command     TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        source      TEXT NOT NULL,
        exit_code   INTEGER,
        thread_id   TEXT,
        trust_all   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_shell_audit_log_timestamp
        ON shell_audit_log (timestamp);
      CREATE INDEX IF NOT EXISTS idx_shell_audit_log_thread_id
        ON shell_audit_log (thread_id);
    `,
  },
  {
    // Heuristic file-op classification of `command`, computed once here at
    // write time (see shell-command-classifier.ts) rather than re-derived
    // per query with fragile LIKE clauses. Three independent booleans, not
    // one category — a chained shell_exec command commonly does more than
    // one kind of thing in a single call.
    version: 32,
    sql: `
      ALTER TABLE shell_audit_log ADD COLUMN is_file_read  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shell_audit_log ADD COLUMN is_file_write INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE shell_audit_log ADD COLUMN is_other      INTEGER NOT NULL DEFAULT 0;

      CREATE VIEW IF NOT EXISTS v_file_tool_adoption AS
      SELECT
        date(s.started_at) AS date,
        'file-ops' AS source,
        SUM(CASE WHEN s.name IN ('find_file','read_file') THEN 1 ELSE 0 END) AS read_count,
        SUM(CASE WHEN s.name = 'edit_file' THEN 1 ELSE 0 END) AS write_count
      FROM observability_spans s
      WHERE s.type = 'tool-call' AND s.name IN ('find_file', 'read_file', 'edit_file')
      GROUP BY date(s.started_at)

      UNION ALL

      SELECT
        date(a.timestamp) AS date,
        'shell_exec' AS source,
        SUM(CASE WHEN a.is_file_read  = 1 THEN 1 ELSE 0 END) AS read_count,
        SUM(CASE WHEN a.is_file_write = 1 THEN 1 ELSE 0 END) AS write_count
      FROM shell_audit_log a
      GROUP BY date(a.timestamp);
    `,
  },
];

export class ShellAuditStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  write(entry: AuditEntry): void {
    const classification = classifyShellCommand(entry.command);
    this.db
      .prepare(
        `INSERT INTO shell_audit_log
          (id, timestamp, command, outcome, source, exit_code, thread_id, trust_all,
           is_file_read, is_file_write, is_other)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        entry.timestamp,
        entry.command,
        entry.outcome,
        entry.source,
        entry.exitCode ?? null,
        entry.threadId ?? null,
        entry.trustAll ? 1 : 0,
        classification.isFileRead ? 1 : 0,
        classification.isFileWrite ? 1 : 0,
        classification.isOther ? 1 : 0,
      );
  }

  queryFileToolAdoption(filters: {
    from: string;
    to: string;
  }): { date: string; source: string; readCount: number; writeCount: number }[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM v_file_tool_adoption WHERE date >= ? AND date <= ? ORDER BY date ASC, source ASC`,
      )
      .all([filters.from, filters.to]) as {
      date: string;
      source: string;
      read_count: number;
      write_count: number;
    }[];

    return rows.map((row) => ({
      date: row.date,
      source: row.source,
      readCount: row.read_count,
      writeCount: row.write_count,
    }));
  }

  makeWriter(): AuditWriter {
    return async (entry: AuditEntry) => {
      this.write(entry);
    };
  }
}

let _store: ShellAuditStore | null = null;

export function bootShellAudit(db: SqliteDatabase): void {
  _store = new ShellAuditStore(db);
}

export function getShellAuditWriter(): AuditWriter {
  if (!_store) throw new Error('ShellAuditStore not initialised — call bootShellAudit() first');
  return _store.makeWriter();
}

export function getShellAuditStore(): ShellAuditStore {
  if (!_store) throw new Error('ShellAuditStore not initialised — call bootShellAudit() first');
  return _store;
}
