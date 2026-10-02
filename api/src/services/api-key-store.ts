import { randomUUID, createHash } from 'node:crypto';
import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';

// API keys used as bearer tokens by external callers of
// POST /api/v1/webhooks/tasks (see
// docs/superpowers/specs/2026-10-02-webhook-task-creation-design.md). Global
// (not scoped to a workspace or user) — acceptable while the app is
// single-user. Only the SHA-256 hash of a key's secret is ever persisted;
// the raw secret is returned once, from create() and rotate(), and cannot
// be recovered afterward — only rotated.

export interface ApiKey {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

const MIGRATIONS: DbMigration[] = [
  {
    version: 35,
    sql: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        key_hash    TEXT NOT NULL UNIQUE,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
];

interface RawApiKeyRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

// High-entropy random data, not a human-chosen password — SHA-256 is the
// right tool (fast lookup on every webhook call), not a slow KDF like
// bcrypt, which exists to slow down guessing low-entropy secrets.
function generateSecret(): string {
  return `ahb_${randomUUID()}${randomUUID()}`.replace(/-/g, '');
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function mapApiKey(row: RawApiKeyRow): ApiKey {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class ApiKeyStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  create(name: string): CreatedApiKey {
    const id = randomUUID();
    const key = generateSecret();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name, hashSecret(key), now, now);
    return { id, name, key, createdAt: now, updatedAt: now };
  }

  list(): ApiKey[] {
    return (
      this.db
        .prepare(`SELECT id, name, created_at, updated_at FROM api_keys ORDER BY created_at ASC`)
        .all() as RawApiKeyRow[]
    ).map(mapApiKey);
  }

  // Overwrites the existing row's secret in place — same id and name, old
  // secret dead immediately. Returns null if no key with this id exists.
  rotate(id: string): CreatedApiKey | null {
    const existing = this.db.prepare(`SELECT id, name FROM api_keys WHERE id = ?`).get(id) as
      { id: string; name: string } | undefined;
    if (!existing) return null;
    const key = generateSecret();
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE api_keys SET key_hash = ?, updated_at = ? WHERE id = ?`)
      .run(hashSecret(key), now, id);
    return { id, name: existing.name, key, createdAt: now, updatedAt: now };
  }

  // Hard delete — no soft-delete/audit trail, consistent with how other
  // first-class rows in this codebase are removed (e.g. deleteTask()).
  revoke(id: string): boolean {
    return this.db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id).changes > 0;
  }

  verify(secret: string): boolean {
    return (
      this.db.prepare(`SELECT id FROM api_keys WHERE key_hash = ?`).get(hashSecret(secret)) !==
      undefined
    );
  }
}

let _store: ApiKeyStore | null = null;

export function bootApiKeyStore(db: SqliteDatabase): void {
  _store = new ApiKeyStore(db);
  logger.info('API key store opened');
}

export function getApiKeyStore(): ApiKeyStore {
  if (!_store) throw new Error('API key store not initialised — call bootApiKeyStore() first');
  return _store;
}
