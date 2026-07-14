import Database from 'better-sqlite3';
import type { DbMigration } from './types.js';

// Abstract base class for all SQLite-backed stores in this application.
//
// Provides the shared migration infrastructure: a `schema_migrations` table that
// tracks which DDL versions have been applied, and `runMigrations()` to apply any
// pending ones at startup.
//
// Subclasses define a private constructor + a `static open(dbPath)` factory that:
//   1. Creates the Database instance and sets pragmas.
//   2. Calls `new SubClass(db)` (which calls `super(db)`).
//   3. Calls `this.runMigrations(MIGRATIONS)`.
// `close()` is inherited and delegates to `db.close()`.
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
