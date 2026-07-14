import Database from 'better-sqlite3';
import type { DbMigration } from './types.js';

// Named alias for the better-sqlite3 connection instance type.
// Import this instead of importing better-sqlite3 directly in code that only
// needs to pass the connection around (no new Database() calls needed).
export type SqliteDatabase = Database.Database;

// Opens a SQLite database with the pragmas required by this application:
//   - WAL mode for better concurrent read throughput
//   - foreign key enforcement
//
// Call this once at application startup and pass the returned connection to
// every store constructor. Sharing one connection across all stores keeps the
// write path serialised (SQLite's one-writer model) and lets WAL readers
// proceed without blocking each other.
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// Abstract base class for all SQLite-backed stores in this application.
//
// Provides the shared migration infrastructure: a `schema_migrations` table that
// tracks which DDL versions have been applied, and `runMigrations()` to apply any
// pending ones at startup.
//
// Subclasses accept the shared Database connection in their constructor, call
// super(db), then call this.runMigrations(MIGRATIONS) with their own DDL list.
// The connection is created externally (via openDatabase) so that all stores
// opened at startup share a single file handle.
export abstract class BaseStore {
  protected readonly db: Database.Database;

  protected constructor(db: Database.Database) {
    this.db = db;
  }

  // Applies any MIGRATIONS whose version is not yet recorded in schema_migrations.
  // Idempotent — safe to call on every startup.
  protected runMigrations(migrations: DbMigration[]): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );
    `);

    const applied = new Set<number>(
      (
        this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{
          version: number;
        }>
      ).map((r) => r.version),
    );

    const insertMigration = this.db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.db.exec(migration.sql);
      insertMigration.run(migration.version, new Date().toISOString());
    }
  }

  close(): void {
    this.db.close();
  }
}
