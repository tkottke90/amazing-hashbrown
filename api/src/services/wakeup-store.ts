import { randomUUID } from 'node:crypto';
import { BaseStore, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';
import { getThreadStore, type ThreadStore } from './thread-store.js';

// Timed agent wake-ups (issue #191): an agent in a chat or workspace-chat
// thread schedules one, ends its turn, and is resumed in the same thread
// with its own note when it fires. The `thread_wakeups` table (created by
// ThreadStore's migration v34, so the FK to threads cascades) is the
// source of truth; each wake-up's `wakeup` transcript card is a projection
// of its row. This store is the only writer of both, and updates them in
// one transaction so they can't drift. Timers live in WakeupRegistry
// (wakeup-registry.ts). See
// docs/superpowers/specs/2026-09-27-agent-wait-design.md §2.

export const WAKEUP_MIN_DELAY_S = 10;
export const WAKEUP_MAX_DELAY_S = 2 * 60 * 60;
// Consecutive wake-ups a thread may chain without a user message between.
export const WAKEUP_MAX_CHAIN = 12;

export type WakeupStatus = 'pending' | 'fired' | 'cancelled';
export type WakeupFireSource = 'timer' | 'trigger_now' | 'catch_up';
export type WakeupCancelSource = 'user_cancel' | 'agent_cancel';
export type WakeupSettledBy = WakeupFireSource | WakeupCancelSource;

export interface Wakeup {
  id: string;
  threadId: string;
  note: string;
  fireAt: string;
  status: WakeupStatus;
  chainDepth: number;
  createdAt: string;
  settledAt: string | null;
  settledBy: WakeupSettledBy | null;
  cancelReason: string | null;
}

// Payload of the `wakeup` transcript card. `state` rather than `status`:
// toClientMessage() (threads.handlers.ts) lets a row's own `status` column
// override a payload field of that name.
export interface WakeupCardPayload {
  wakeupId: string;
  note: string;
  fireAt: string;
  state: WakeupStatus;
  settledBy?: WakeupSettledBy;
  settledAt?: string;
  cancelReason?: string;
}

// Payload of the immutable `wakeup_fired` marker written right before the
// turn a wake-up starts.
export interface WakeupFiredPayload {
  wakeupId: string;
  note: string;
  settledBy: WakeupFireSource;
  firedAt: string;
  lateByMs?: number;
}

export interface ScheduleWakeupInput {
  threadId: string;
  note: string;
  fireAt: Date;
  chainDepth: number;
}

// Thrown by schedule() when the thread already has a pending wake-up —
// normally caught earlier by the tool's own getPending() check; this is the
// database-level backstop (partial unique index).
export class PendingWakeupExistsError extends Error {
  constructor(readonly threadId: string) {
    super(`Thread ${threadId} already has a pending wake-up`);
    this.name = 'PendingWakeupExistsError';
  }
}

interface RawWakeupRow {
  id: string;
  thread_id: string;
  note: string;
  fire_at: string;
  status: WakeupStatus;
  chain_depth: number;
  created_at: string;
  settled_at: string | null;
  settled_by: WakeupSettledBy | null;
  cancel_reason: string | null;
}

function mapRow(row: RawWakeupRow): Wakeup {
  return {
    id: row.id,
    threadId: row.thread_id,
    note: row.note,
    fireAt: row.fire_at,
    status: row.status,
    chainDepth: row.chain_depth,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    settledBy: row.settled_by,
    cancelReason: row.cancel_reason,
  };
}

export function toCardPayload(wakeup: Wakeup): WakeupCardPayload {
  return {
    wakeupId: wakeup.id,
    note: wakeup.note,
    fireAt: wakeup.fireAt,
    state: wakeup.status,
    ...(wakeup.settledBy ? { settledBy: wakeup.settledBy } : {}),
    ...(wakeup.settledAt ? { settledAt: wakeup.settledAt } : {}),
    ...(wakeup.cancelReason ? { cancelReason: wakeup.cancelReason } : {}),
  };
}

export interface WakeupStoreOptions {
  now?: () => Date;
}

export class WakeupStore extends BaseStore {
  private readonly now: () => Date;

  // The thread_wakeups table itself is created by ThreadStore's migrations
  // (it must exist before this store is used, which bootWakeupStore()
  // guarantees by requiring the thread store first).
  constructor(
    db: SqliteDatabase,
    private readonly threads: ThreadStore,
    options: WakeupStoreOptions = {},
  ) {
    super(db);
    this.now = options.now ?? (() => new Date());
  }

  // Inserts the pending row and its `wakeup` card (card id = wakeup id).
  schedule(input: ScheduleWakeupInput): Wakeup {
    const wakeup: Wakeup = {
      id: randomUUID(),
      threadId: input.threadId,
      note: input.note,
      fireAt: input.fireAt.toISOString(),
      status: 'pending',
      chainDepth: input.chainDepth,
      createdAt: this.now().toISOString(),
      settledAt: null,
      settledBy: null,
      cancelReason: null,
    };
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO thread_wakeups (id, thread_id, note, fire_at, status, chain_depth, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          wakeup.id,
          wakeup.threadId,
          wakeup.note,
          wakeup.fireAt,
          wakeup.chainDepth,
          wakeup.createdAt,
        );
      this.threads.insertMessage(wakeup.threadId, {
        id: wakeup.id,
        kind: 'wakeup',
        payload: toCardPayload(wakeup),
      });
    });
    try {
      insert();
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new PendingWakeupExistsError(input.threadId);
      }
      throw err;
    }
    return wakeup;
  }

  get(id: string): Wakeup | null {
    const row = this.db.prepare(`SELECT * FROM thread_wakeups WHERE id = ?`).get(id) as
      RawWakeupRow | undefined;
    return row ? mapRow(row) : null;
  }

  getPending(threadId: string): Wakeup | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_wakeups WHERE thread_id = ? AND status = 'pending'`)
      .get(threadId) as RawWakeupRow | undefined;
    return row ? mapRow(row) : null;
  }

  listPending(): Wakeup[] {
    const rows = this.db
      .prepare(`SELECT * FROM thread_wakeups WHERE status = 'pending' ORDER BY fire_at`)
      .all() as RawWakeupRow[];
    return rows.map(mapRow);
  }

  // pending -> fired. Returns null when the wake-up is missing or no longer
  // pending — the race gate every caller relies on (a cancel and a fire
  // can't both win).
  markFired(id: string, settledBy: WakeupFireSource): Wakeup | null {
    return this.settle(id, 'fired', settledBy, null);
  }

  // pending -> cancelled. Same null contract as markFired().
  cancel(id: string, settledBy: WakeupCancelSource, reason?: string): Wakeup | null {
    return this.settle(id, 'cancelled', settledBy, reason?.trim() || null);
  }

  // Writes the immutable marker that precedes a wake-up's turn in the
  // transcript, so the agent's reply isn't a response to nothing.
  recordFiredMarker(wakeup: Wakeup, settledBy: WakeupFireSource, lateByMs?: number): void {
    const payload: WakeupFiredPayload = {
      wakeupId: wakeup.id,
      note: wakeup.note,
      settledBy,
      firedAt: this.now().toISOString(),
      ...(lateByMs && lateByMs > 0 ? { lateByMs } : {}),
    };
    try {
      this.threads.insertMessage(wakeup.threadId, {
        id: randomUUID(),
        kind: 'wakeup_fired',
        payload,
      });
    } catch (err) {
      // The thread was deleted between fire and delivery — nothing to mark.
      logger.warn('wakeup-store: could not record fired marker', {
        wakeupId: wakeup.id,
        err: String(err),
      });
    }
  }

  private settle(
    id: string,
    status: Exclude<WakeupStatus, 'pending'>,
    settledBy: WakeupSettledBy,
    cancelReason: string | null,
  ): Wakeup | null {
    const settledAt = this.now().toISOString();
    const run = this.db.transaction((): Wakeup | null => {
      const changed = this.db
        .prepare(
          `UPDATE thread_wakeups
              SET status = ?, settled_at = ?, settled_by = ?, cancel_reason = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(status, settledAt, settledBy, cancelReason, id);
      if (changed.changes === 0) return null;
      const wakeup = this.get(id)!;
      this.threads.updateMessage(wakeup.threadId, wakeup.id, { payload: toCardPayload(wakeup) });
      return wakeup;
    });
    return run();
  }
}

// ---------------------------------------------------------------------------
// Boot wiring — mirrors thread-store.ts
// ---------------------------------------------------------------------------

let _store: WakeupStore | null = null;

// Requires bootThreadStore() first — the table comes from its migrations.
export function bootWakeupStore(db: SqliteDatabase): void {
  _store = new WakeupStore(db, getThreadStore());
  logger.info('Wake-up store opened');
}

export function getWakeupStore(): WakeupStore {
  if (!_store) throw new Error('Wake-up store not initialised — call bootWakeupStore() first');
  return _store;
}
