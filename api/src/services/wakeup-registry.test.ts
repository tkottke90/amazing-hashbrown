import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore } from './thread-store.js';
import { WakeupStore, type Wakeup, type WakeupFireSource } from './wakeup-store.js';
import { WakeupRegistry } from './wakeup-registry.js';

// Hand-rolled fake clock + timer queue (the repo has no sinon) — same shape
// as cron-registry.test.ts's: timers only run when advanceTo() passes them.
class FakeClock {
  private nowMs: number;
  private nextId = 1;
  timers = new Map<number, { fn: () => void; at: number }>();

  constructor(iso: string) {
    this.nowMs = new Date(iso).getTime();
  }

  now = () => new Date(this.nowMs);

  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.nowMs + ms });
    return id;
  };

  clearTimer = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  set(iso: string) {
    this.nowMs = new Date(iso).getTime();
  }

  advanceTo(iso: string) {
    const target = new Date(iso).getTime();
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.nowMs = Math.max(this.nowMs, due[1].at);
      due[1].fn();
    }
    this.nowMs = target;
  }
}

interface Delivery {
  wakeup: Wakeup;
  settledBy: WakeupFireSource;
  lateByMs: number;
}

describe('services/wakeup-registry', () => {
  let dir: string;
  let threads: ThreadStore;
  let store: WakeupStore;
  let clock: FakeClock;
  let registry: WakeupRegistry;
  let deliveries: Delivery[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wakeup-registry-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    threads = new ThreadStore(db);
    clock = new FakeClock('2026-09-27T12:00:00.000Z');
    store = new WakeupStore(db, threads, { now: clock.now });
    threads.upsertThreadOnFirstMessage('thread-1', 'deploy', 'chat');
    threads.upsertThreadOnFirstMessage('thread-2', 'ci', 'chat');
    deliveries = [];
    registry = new WakeupRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      store: () => store,
      deliver: (wakeup, settledBy, lateByMs) => {
        deliveries.push({ wakeup, settledBy, lateByMs });
      },
    });
  });

  afterEach(() => {
    registry.stop();
    threads.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function schedule(fireAtIso: string, threadId = 'thread-1'): Wakeup {
    return store.schedule({
      threadId,
      note: 'check it',
      fireAt: new Date(fireAtIso),
      chainDepth: 1,
    });
  }

  describe('sync', () => {
    it('arms a timer for a newly scheduled wake-up [unit]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');

      registry.sync(wakeup.id);

      expect(registry.armedFor(wakeup.id)?.toISOString()).to.equal('2026-09-27T12:15:00.000Z');
    });

    it('fires at the fire time and delivers the settled wake-up exactly once [orchestration]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      registry.sync(wakeup.id);

      clock.advanceTo('2026-09-27T12:14:59.000Z');
      expect(deliveries).to.have.length(0);

      clock.advanceTo('2026-09-27T12:30:00.000Z');
      expect(deliveries).to.have.length(1);
      expect(deliveries[0]).to.deep.include({ settledBy: 'timer', lateByMs: 0 });
      expect(deliveries[0]!.wakeup.status).to.equal('fired');
      expect(store.get(wakeup.id)?.status).to.equal('fired');
      expect(registry.armedFor(wakeup.id)).to.equal(null);
    });

    it('does not arm a wake-up that is no longer pending [unit]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      store.cancel(wakeup.id, 'user_cancel');

      registry.sync(wakeup.id);

      expect(registry.armedFor(wakeup.id)).to.equal(null);
    });
  });

  describe('boot', () => {
    it('re-arms future wake-ups after a restart [orchestration]', () => {
      const wakeup = schedule('2026-09-27T13:00:00.000Z');

      registry.boot();

      expect(registry.armedFor(wakeup.id)?.toISOString()).to.equal('2026-09-27T13:00:00.000Z');
      expect(deliveries).to.have.length(0);
    });

    it('fires a wake-up missed during downtime once, as a catch-up carrying its lateness [orchestration]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      clock.set('2026-09-27T12:57:00.000Z');

      registry.boot();

      expect(deliveries).to.have.length(1);
      expect(deliveries[0]).to.deep.include({ settledBy: 'catch_up', lateByMs: 42 * 60_000 });
      expect(store.get(wakeup.id)?.settledBy).to.equal('catch_up');
      expect(registry.armedFor(wakeup.id)).to.equal(null);
    });
  });

  describe('triggerNow', () => {
    it('fires immediately and removes the pending timer, so it cannot fire twice [orchestration]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      registry.sync(wakeup.id);

      const fired = registry.triggerNow(wakeup.id);

      expect(fired?.settledBy).to.equal('trigger_now');
      clock.advanceTo('2026-09-27T13:00:00.000Z');
      expect(deliveries.map((d) => d.settledBy)).to.deep.equal(['trigger_now']);
    });

    it('returns null for a wake-up that already fired [unit]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      registry.triggerNow(wakeup.id);

      expect(registry.triggerNow(wakeup.id)).to.equal(null);
      expect(deliveries).to.have.length(1);
    });
  });

  describe('cancel', () => {
    it('cancels and disarms, so the timer never delivers [orchestration]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      registry.sync(wakeup.id);

      const cancelled = registry.cancel(wakeup.id, 'user_cancel');

      expect(cancelled?.status).to.equal('cancelled');
      clock.advanceTo('2026-09-27T13:00:00.000Z');
      expect(deliveries).to.have.length(0);
    });

    it('a timer that fires after a cancel slipped past it delivers nothing [orchestration]', () => {
      const wakeup = schedule('2026-09-27T12:15:00.000Z');
      registry.sync(wakeup.id);
      // Cancel through the store directly — the registry's timer stays armed.
      store.cancel(wakeup.id, 'agent_cancel');

      clock.advanceTo('2026-09-27T13:00:00.000Z');

      expect(deliveries).to.have.length(0);
      expect(store.get(wakeup.id)?.status).to.equal('cancelled');
    });
  });

  describe('clearThread', () => {
    it('drops only the deleted thread timers [unit]', () => {
      const a = schedule('2026-09-27T12:15:00.000Z', 'thread-1');
      const b = schedule('2026-09-27T12:20:00.000Z', 'thread-2');
      registry.sync(a.id);
      registry.sync(b.id);

      registry.clearThread('thread-1');

      expect(registry.armedFor(a.id)).to.equal(null);
      expect(registry.armedFor(b.id)).to.not.equal(null);
    });
  });

  describe('fire', () => {
    it('never throws when delivery fails, and still settles the wake-up [unit]', () => {
      const failing = new WakeupRegistry({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        store: () => store,
        deliver: () => {
          throw new Error('agent build failed');
        },
      });
      const wakeup = schedule('2026-09-27T12:00:00.000Z');

      expect(() => failing.fire(wakeup.id, 'timer')).not.to.throw();
      expect(store.get(wakeup.id)?.status).to.equal('fired');
    });
  });
});
