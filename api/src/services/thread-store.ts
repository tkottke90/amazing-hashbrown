import { BaseStore, type DbMigration, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadType = 'chat' | 'wiki';

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  forkedFromThreadId: string | null;
  forkedFromSeq: number | null;
  type: ThreadType;
  provider: string | null;
  model: string | null;
}

export interface ThreadMessageRecord {
  id: string;
  threadId: string;
  seq: number;
  kind: string;
  status: string | null;
  retryOf: string | null;
  checkpointId: string | null;
  payload: unknown;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ThreadMessageRecord[];
}

export interface NewThreadMessageInput {
  id: string;
  kind: string;
  status?: string | null;
  retryOf?: string | null;
  checkpointId?: string | null;
  payload: unknown;
  provider?: string | null;
  model?: string | null;
}

export interface UpdateThreadMessageInput {
  status?: string;
  checkpointId?: string;
  payload?: unknown;
}

interface RawThreadRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  forked_from_thread_id: string | null;
  forked_from_seq: number | null;
  type: ThreadType;
  provider: string | null;
  model: string | null;
}

interface RawMessageRow {
  id: string;
  thread_id: string;
  seq: number;
  kind: string;
  status: string | null;
  retry_of: string | null;
  checkpoint_id: string | null;
  payload: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Row <-> record mapping
// ---------------------------------------------------------------------------

function mapThreadRow(row: RawThreadRow): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forkedFromThreadId: row.forked_from_thread_id,
    forkedFromSeq: row.forked_from_seq,
    type: row.type,
    provider: row.provider,
    model: row.model,
  };
}

function mapMessageRow(row: RawMessageRow): ThreadMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    retryOf: row.retry_of,
    checkpointId: row.checkpoint_id,
    payload: JSON.parse(row.payload) as unknown,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// DDL migrations
// ---------------------------------------------------------------------------

// Version numbers must be unique across ALL stores sharing this database.
// 1=observability, 2=cost-store, 3=evaluations, 4=threads, 5=observability,
// 6=evaluations (judge_calibrations), 7=observability, 8=evaluations,
// 9=(free), 10-12=threads (type column), 13-16=threads (provider/model columns).
// Check every store's MIGRATIONS array before adding a new one here — a
// colliding version silently no-ops instead of erroring (BaseStore.runMigrations
// skips any version already recorded).
const MIGRATIONS: DbMigration[] = [
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS threads (
        id                     TEXT PRIMARY KEY,
        title                  TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        forked_from_thread_id  TEXT,
        forked_from_seq        INTEGER
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        id             TEXT NOT NULL,
        thread_id      TEXT NOT NULL REFERENCES threads(id),
        seq            INTEGER NOT NULL,
        kind           TEXT NOT NULL,
        status         TEXT,
        retry_of       TEXT,
        checkpoint_id  TEXT,
        payload        TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (thread_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, seq);
    `,
  },
  {
    version: 10,
    // Step 1: add nullable column so existing rows don't violate a NOT NULL constraint.
    sql: `ALTER TABLE threads ADD COLUMN type TEXT`,
  },
  {
    version: 11,
    // Step 2: back-fill all pre-existing rows as 'chat' threads.
    sql: `UPDATE threads SET type = 'chat' WHERE type IS NULL`,
  },
  {
    version: 12,
    // Step 3: recreate the table with NOT NULL enforced (SQLite doesn't support
    // adding a NOT NULL constraint to an existing column via ALTER TABLE).
    sql: `
      CREATE TABLE threads_new (
        id                     TEXT PRIMARY KEY,
        title                  TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        forked_from_thread_id  TEXT,
        forked_from_seq        INTEGER,
        type                   TEXT NOT NULL DEFAULT 'chat'
      );
      INSERT INTO threads_new SELECT id, title, created_at, updated_at, forked_from_thread_id, forked_from_seq, type FROM threads;
      DROP TABLE threads;
      ALTER TABLE threads_new RENAME TO threads;
    `,
  },
  {
    version: 13,
    sql: `ALTER TABLE threads ADD COLUMN provider TEXT`,
  },
  {
    version: 14,
    sql: `ALTER TABLE threads ADD COLUMN model TEXT`,
  },
  {
    version: 15,
    sql: `ALTER TABLE thread_messages ADD COLUMN provider TEXT`,
  },
  {
    version: 16,
    sql: `ALTER TABLE thread_messages ADD COLUMN model TEXT`,
  },
];

// ---------------------------------------------------------------------------
// ThreadStore
// ---------------------------------------------------------------------------

export class ThreadStore extends BaseStore {
  constructor(db: SqliteDatabase) {
    super(db);
    this.runMigrations(MIGRATIONS);
  }

  // -------------------------------------------------------------------------
  // Thread metadata
  // -------------------------------------------------------------------------

  // Inserts the threads row on the first message of a new thread; a no-op if
  // the row already exists. Call this before the first insertMessage() of a
  // turn, not on every turn.
  upsertThreadOnFirstMessage(threadId: string, titleSeed: string, type: ThreadType = 'chat'): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO threads (id, title, created_at, updated_at, type) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(threadId, titleSeed, now, now, type);
  }

  // Bumps updated_at — new message activity, a rename, or a title regen all
  // count (see docs/Design/2026-07-18-persistent-conversation-memory-design.md).
  touchThread(threadId: string): void {
    this.db
      .prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), threadId);
  }

  listThreads(filter?: { type: ThreadType }): ThreadSummary[] {
    const rows = (
      filter
        ? this.db
            .prepare(`SELECT * FROM threads WHERE type = ? ORDER BY updated_at DESC`)
            .all(filter.type)
        : this.db.prepare(`SELECT * FROM threads ORDER BY updated_at DESC`).all()
    ) as RawThreadRow[];
    return rows.map(mapThreadRow);
  }

  getThreadMeta(id: string): ThreadSummary | null {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as
      | RawThreadRow
      | undefined;
    return row ? mapThreadRow(row) : null;
  }

  // Returns null if the thread doesn't exist; the caller (handler layer) maps
  // that to a 404. Renaming counts as activity — bumps updated_at.
  renameThread(id: string, title: string): ThreadSummary | null {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, now, id);
    if (result.changes === 0) return null;
    return this.getThreadMeta(id);
  }

  // Deletes the threads row and all of its thread_messages rows. Does NOT
  // touch the LangGraph checkpointer — the handler layer composes that call
  // separately, since ThreadStore has no knowledge of LangGraph.
  deleteThread(id: string): boolean {
    const doDelete = this.db.transaction((threadId: string) => {
      this.db.prepare(`DELETE FROM thread_messages WHERE thread_id = ?`).run(threadId);
      return this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
    });
    const result = doDelete(id);
    return result.changes > 0;
  }

  createForkedThread(
    newThreadId: string,
    title: string,
    forkedFromThreadId: string,
    forkedFromSeq: number,
    type: ThreadType = 'chat',
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO threads (id, title, created_at, updated_at, forked_from_thread_id, forked_from_seq, type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newThreadId, title, now, now, forkedFromThreadId, forkedFromSeq, type);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private nextSeq(threadId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM thread_messages WHERE thread_id = ?`)
      .get(threadId) as { next: number };
    return row.next;
  }

  // Assigns the next seq and inserts the row, in the same transaction as the
  // seq lookup (better-sqlite3 is synchronous/single-connection, so this is
  // atomic in practice — see the design doc's "seq generation" note).
  insertMessage(threadId: string, message: NewThreadMessageInput): ThreadMessageRecord {
    const now = new Date().toISOString();
    const insert = this.db.transaction(() => {
      const seq = this.nextSeq(threadId);
      this.db
        .prepare(
          `INSERT INTO thread_messages
             (id, thread_id, seq, kind, status, retry_of, checkpoint_id, payload, provider, model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          threadId,
          seq,
          message.kind,
          message.status ?? null,
          message.retryOf ?? null,
          message.checkpointId ?? null,
          JSON.stringify(message.payload),
          message.provider ?? null,
          message.model ?? null,
          now,
          now,
        );
      return seq;
    });
    const seq = insert();
    return {
      id: message.id,
      threadId,
      seq,
      kind: message.kind,
      status: message.status ?? null,
      retryOf: message.retryOf ?? null,
      checkpointId: message.checkpointId ?? null,
      payload: message.payload,
      provider: message.provider ?? null,
      model: message.model ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Partial update of an existing row (e.g. streaming -> done, pending -> done).
  // No-op if the row doesn't exist.
  updateMessage(threadId: string, id: string, patch: UpdateThreadMessageInput): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.checkpointId !== undefined) {
      sets.push('checkpoint_id = ?');
      values.push(patch.checkpointId);
    }
    if (patch.payload !== undefined) {
      sets.push('payload = ?');
      values.push(JSON.stringify(patch.payload));
    }

    const now = new Date().toISOString();
    sets.push('updated_at = ?');
    values.push(now);

    this.db
      .prepare(`UPDATE thread_messages SET ${sets.join(', ')} WHERE thread_id = ? AND id = ?`)
      .run(...values, threadId, id);
  }

  // A single row, or null if it doesn't exist. updateMessage() replaces
  // `payload` wholesale rather than merging (see its own tests), so a caller
  // that needs to patch just one field of an existing payload (e.g.
  // resolveHitlPrompt adding `answer`) fetches the current row first.
  getMessage(threadId: string, id: string): ThreadMessageRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_messages WHERE thread_id = ? AND id = ?`)
      .get(threadId, id) as RawMessageRow | undefined;
    return row ? mapMessageRow(row) : null;
  }

  // Returns the id of the thread's most recent message if it's a failed
  // (status: 'error') assistant turn, or null otherwise. Retry only ever
  // targets the tail — see the design doc's retry scope constraint. Always
  // considers the raw last row regardless of showErrorMessages, since this
  // checks actual state, not display visibility.
  resolveRetryTarget(threadId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id, kind, status FROM thread_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId) as { id: string; kind: string; status: string | null } | undefined;
    if (row && row.kind === 'assistant' && row.status === 'error') return row.id;
    return null;
  }

  // Sweeps any tool_call rows still 'pending' for this thread to 'interrupted'
  // when the enclosing turn fails — see the design doc's "Dangling tool_call
  // rows" note. There is only ever one turn in flight per thread, so no
  // per-turn scoping beyond thread_id is needed.
  interruptPendingToolCalls(threadId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE thread_messages
         SET status = 'interrupted', updated_at = ?
         WHERE thread_id = ? AND kind = 'tool_call' AND status = 'pending'`,
      )
      .run(now, threadId);
  }

  // Returns the thread's messages, newest-`limit` capped (soft cap, no
  // pagination — see design doc's "Out of Scope"), oldest-first for display.
  // Hides a status:'error' row only if it has been superseded by a retry
  // (another row's retry_of points at it) and showErrors is false — an
  // unresolved failure at the tail is always visible regardless of the flag.
  getThreadMessages(
    threadId: string,
    opts: { showErrors?: boolean; limit?: number } = {},
  ): ThreadMessageRecord[] {
    const { showErrors = false, limit = 200 } = opts;
    const rows = this.db
      .prepare(`SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`)
      .all(threadId, limit) as RawMessageRow[];
    const chronological = rows.reverse();

    if (showErrors) return chronological.map(mapMessageRow);

    const superseded = new Set(
      chronological.filter((r) => r.retry_of !== null).map((r) => r.retry_of),
    );
    return chronological
      .filter((r) => !(r.status === 'error' && superseded.has(r.id)))
      .map(mapMessageRow);
  }

  getThread(id: string, opts: { showErrors?: boolean } = {}): ThreadDetail | null {
    const meta = this.getThreadMeta(id);
    if (!meta) return null;
    return { ...meta, messages: this.getThreadMessages(id, opts) };
  }

  // -------------------------------------------------------------------------
  // Fork support
  // -------------------------------------------------------------------------

  // Finds the checkpoint_id anchored at the nearest completed
  // (status: 'done') assistant turn at or before atSeq. Null if none
  // qualifies (e.g. atSeq lands before any turn completed).
  resolveForkCheckpointId(threadId: string, atSeq: number): string | null {
    const row = this.db
      .prepare(
        `SELECT checkpoint_id FROM thread_messages
         WHERE thread_id = ? AND kind = 'assistant' AND status = 'done' AND seq <= ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId, atSeq) as { checkpoint_id: string | null } | undefined;
    return row?.checkpoint_id ?? null;
  }

  // Copies thread_messages rows where seq <= atSeq into newThreadId, ids and
  // timestamps preserved (the composite PK scopes ids per-thread, so no
  // remapping is needed — see design doc's fork mechanics).
  copyMessagesToNewThread(sourceThreadId: string, newThreadId: string, atSeq: number): void {
    const rows = this.db
      .prepare(`SELECT * FROM thread_messages WHERE thread_id = ? AND seq <= ? ORDER BY seq ASC`)
      .all(sourceThreadId, atSeq) as RawMessageRow[];

    const insert = this.db.prepare(
      `INSERT INTO thread_messages
         (id, thread_id, seq, kind, status, retry_of, checkpoint_id, payload, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = this.db.transaction((rowsToCopy: RawMessageRow[]) => {
      for (const r of rowsToCopy) {
        insert.run(
          r.id,
          newThreadId,
          r.seq,
          r.kind,
          r.status,
          r.retry_of,
          r.checkpoint_id,
          r.payload,
          r.provider,
          r.model,
          r.created_at,
          r.updated_at,
        );
      }
    });
    insertAll(rows);
  }

  updateThreadModel(threadId: string, provider: string | null, model: string | null): void {
    this.db
      .prepare(`UPDATE threads SET provider = ?, model = ?, updated_at = ? WHERE id = ?`)
      .run(provider, model, new Date().toISOString(), threadId);
  }
}

// ---------------------------------------------------------------------------
// Boot wiring — mirrors api/src/services/observability.ts
// ---------------------------------------------------------------------------

let _store: ThreadStore | null = null;

export function bootThreadStore(db: SqliteDatabase): void {
  _store = new ThreadStore(db);
  logger.info('Thread store opened');
}

export function getThreadStore(): ThreadStore {
  if (!_store) throw new Error('Thread store not initialised — call bootThreadStore() first');
  return _store;
}
