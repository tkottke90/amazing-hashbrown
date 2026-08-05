import { randomUUID } from 'node:crypto';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import type { AuditEntry, AuditWriter } from '@tkottke90/shell-executor';

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
];

export class ShellAuditStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  write(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO shell_audit_log
          (id, timestamp, command, outcome, source, exit_code, thread_id, trust_all)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
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
