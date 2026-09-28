import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore } from './thread-store.js';
import {
  WakeupStore,
  PendingWakeupExistsError,
  toCardPayload,
  type Wakeup,
} from './wakeup-store.js';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const IN_15M = new Date('2026-09-27T12:15:00.000Z');

describe('services/wakeup-store', () => {
  let dir: string;
  let threads: ThreadStore;
  let store: WakeupStore;
  let threadId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wakeup-store-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    threads = new ThreadStore(db);
    store = new WakeupStore(db, threads, { now: () => NOW });
    threadId = 'thread-1';
    threads.upsertThreadOnFirstMessage(threadId, 'deploy chat', 'chat');
  });

  afterEach(() => {
    threads.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function schedule(overrides: Partial<{ note: string; chainDepth: number }> = {}): Wakeup {
    return store.schedule({
      threadId,
      note: overrides.note ?? 'Run kubectl rollout status deploy/api',
      fireAt: IN_15M,
      chainDepth: overrides.chainDepth ?? 1,
    });
  }

  function card(wakeupId: string) {
    return threads.getMessage(threadId, wakeupId);
  }

  describe('schedule', () => {
    it('stores a pending wake-up that getPending and listPending return [unit]', () => {
      const wakeup = schedule();

      expect(wakeup).to.include({
        threadId,
        status: 'pending',
        fireAt: IN_15M.toISOString(),
        chainDepth: 1,
        settledAt: null,
        settledBy: null,
      });
      expect(store.getPending(threadId)).to.deep.equal(wakeup);
      expect(store.listPending()).to.deep.equal([wakeup]);
    });

    it('writes a wakeup card into the transcript so the user can see the pending wait [unit]', () => {
      const wakeup = schedule();

      const row = card(wakeup.id);
      expect(row?.kind).to.equal('wakeup');
      expect(row?.payload).to.deep.equal({
        wakeupId: wakeup.id,
        note: wakeup.note,
        fireAt: IN_15M.toISOString(),
        state: 'pending',
      });
    });

    it('refuses a second pending wake-up in the same thread, leaving no orphan card [unit]', () => {
      schedule();

      expect(() => schedule({ note: 'another' })).to.throw(PendingWakeupExistsError);
      const cards = threads.getThread(threadId)!.messages.filter((m) => m.kind === 'wakeup');
      expect(cards).to.have.length(1);
    });

    it('allows a new wake-up once the previous one has settled [unit]', () => {
      const first = schedule();
      store.markFired(first.id, 'timer');

      expect(() => schedule({ note: 'check again' })).not.to.throw();
    });
  });

  describe('markFired', () => {
    it('settles a pending wake-up and records how it fired [unit]', () => {
      const wakeup = schedule();

      const fired = store.markFired(wakeup.id, 'trigger_now');

      expect(fired).to.include({
        status: 'fired',
        settledBy: 'trigger_now',
        settledAt: NOW.toISOString(),
      });
      expect(store.getPending(threadId)).to.equal(null);
    });

    it('keeps the transcript card in step with the row [unit]', () => {
      const wakeup = schedule();
      store.markFired(wakeup.id, 'timer');

      expect(card(wakeup.id)?.payload).to.deep.equal({
        wakeupId: wakeup.id,
        note: wakeup.note,
        fireAt: IN_15M.toISOString(),
        state: 'fired',
        settledBy: 'timer',
        settledAt: NOW.toISOString(),
      });
    });

    it('returns null for an already-cancelled wake-up, so a cancel/fire race has one winner [unit]', () => {
      const wakeup = schedule();
      store.cancel(wakeup.id, 'user_cancel');

      expect(store.markFired(wakeup.id, 'timer')).to.equal(null);
      expect(store.get(wakeup.id)?.status).to.equal('cancelled');
    });

    it('returns null for an unknown id [unit]', () => {
      expect(store.markFired('nope', 'timer')).to.equal(null);
    });
  });

  describe('cancel', () => {
    it('records who cancelled and why, and shows it on the card [unit]', () => {
      const wakeup = schedule();

      const cancelled = store.cancel(wakeup.id, 'agent_cancel', '  deploy already finished  ');

      expect(cancelled).to.include({
        status: 'cancelled',
        settledBy: 'agent_cancel',
        cancelReason: 'deploy already finished',
      });
      expect(card(wakeup.id)?.payload).to.include({
        state: 'cancelled',
        settledBy: 'agent_cancel',
        cancelReason: 'deploy already finished',
      });
    });

    it('returns null once the wake-up has fired [unit]', () => {
      const wakeup = schedule();
      store.markFired(wakeup.id, 'timer');

      expect(store.cancel(wakeup.id, 'user_cancel')).to.equal(null);
    });
  });

  describe('recordFiredMarker', () => {
    it('appends a wakeup_fired marker after the card, carrying lateness for a catch-up [unit]', () => {
      const wakeup = schedule();
      const fired = store.markFired(wakeup.id, 'catch_up')!;

      store.recordFiredMarker(fired, 'catch_up', 42 * 60_000);

      const messages = threads.getThread(threadId)!.messages;
      const marker = messages[messages.length - 1]!;
      expect(marker.kind).to.equal('wakeup_fired');
      expect(marker.payload).to.deep.equal({
        wakeupId: wakeup.id,
        note: wakeup.note,
        settledBy: 'catch_up',
        firedAt: NOW.toISOString(),
        lateByMs: 42 * 60_000,
      });
    });

    it('does not throw when the thread was deleted before delivery [unit]', () => {
      const wakeup = schedule();
      threads.deleteThread(threadId);

      expect(() => store.recordFiredMarker(wakeup, 'timer')).not.to.throw();
    });
  });

  describe('thread deletion', () => {
    it('removes the thread wake-ups with it, so nothing fires into a deleted thread [unit]', () => {
      const wakeup = schedule();

      threads.deleteThread(threadId);

      expect(store.get(wakeup.id)).to.equal(null);
      expect(store.listPending()).to.deep.equal([]);
    });
  });

  describe('toCardPayload', () => {
    it('omits settlement fields while pending [unit]', () => {
      const wakeup = schedule();
      expect(toCardPayload(wakeup)).to.have.all.keys('wakeupId', 'note', 'fireAt', 'state');
    });
  });
});
