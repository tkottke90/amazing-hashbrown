import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore, CostStore } from '@tkottke90/observability';
import { EvaluationsStore } from '@tkottke90/evaluations';
import { ThreadStore } from './services/thread-store.js';

// Every BaseStore subclass below shares ONE physical db connection in
// production (see index.ts) and therefore one schema_migrations table
// (see @tkottke90/llm-common-types's BaseStore.runMigrations) — migration
// version numbers are a single global sequence, not scoped per store class.
// A colliding version number silently no-ops instead of erroring: whichever
// store boots first "wins" that version, and every other store with the
// same version number never runs its DDL at all — its tables just don't
// exist. This test boots every such store against one connection, in the
// same order index.ts does, and asserts every table each one is supposed to
// create is actually present, so a future version collision fails a test
// instead of surfacing as a "no such table" error at runtime for a user.
describe('shared-database migrations (cross-store)', () => {
  let dir: string;

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates every expected table with no version collisions across stores [orchestration]', () => {
    dir = mkdtempSync(join(tmpdir(), 'db-migrations-test-'));
    const db = openDatabase(join(dir, 'shared.db'));

    // Boot order matches index.ts. Each store's constructor runs its own
    // migrations against the shared connection — none of them are otherwise
    // used here, so their return values only need to exist, not be retained.
    new ObservabilityStore(db);
    new CostStore(db);
    new EvaluationsStore(db);
    new ThreadStore(db);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    const expectedTables = [
      'observability_traces',
      'observability_spans',
      'provider_costs',
      'eval_runs',
      'eval_results',
      'judge_calibrations',
      'threads',
      'thread_messages',
    ];
    for (const table of expectedTables) {
      expect(tables, `expected table "${table}" in: ${JSON.stringify(tables)}`).to.include(table);
    }

    // Every migration version across all four stores must be distinct — a
    // duplicate here is exactly the bug this test exists to catch.
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
      }>
    ).map((r) => r.version);
    expect(
      new Set(versions).size,
      `duplicate version recorded: ${JSON.stringify(versions)}`,
    ).to.equal(versions.length);

    db.close();
  });
});
