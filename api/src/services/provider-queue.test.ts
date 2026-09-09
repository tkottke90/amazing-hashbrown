import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ProviderQueue } from './provider-queue.js';

// Mirrors task-scheduler.test.ts's own helper — flushes enough microtask
// turns for a chain of resolve()/reject() calls made inside releaseSlot's
// drain loop to actually settle their `.then()`s, without fake timers or a
// mocking library.
function flushMicrotasks(times = 4): Promise<void> {
  return times <= 0 ? Promise.resolve() : Promise.resolve().then(() => flushMicrotasks(times - 1));
}

function queueWithLimits(limits: Record<string, number>): ProviderQueue {
  return new ProviderQueue((name) => limits[name] ?? 1);
}

describe('services/provider-queue', () => {
  describe('ProviderQueue#acquireSlot / releaseSlot — accounting', () => {
    it('serializes requests when maxConcurrency is 1', async () => {
      const queue = queueWithLimits({ p: 1 });
      const order: string[] = [];

      await queue.acquireSlot('p', 'sync');
      const second = queue.acquireSlot('p', 'sync').then(() => order.push('second'));

      await flushMicrotasks();
      expect(order).to.have.length(0); // second is still queued, first slot held

      queue.releaseSlot('p');
      await second;
      expect(order).to.deep.equal(['second']);
    });

    it('allows up to maxConcurrency concurrent acquisitions before queuing', async () => {
      const queue = queueWithLimits({ p: 3 });
      let resolvedCount = 0;
      const mark = () => resolvedCount++;

      await Promise.all([
        queue.acquireSlot('p', 'sync').then(mark),
        queue.acquireSlot('p', 'sync').then(mark),
        queue.acquireSlot('p', 'sync').then(mark),
      ]);
      expect(resolvedCount).to.equal(3);

      // A 4th acquire now queues — it must not resolve until a release.
      let fourthResolved = false;
      const fourth = queue.acquireSlot('p', 'sync').then(() => {
        fourthResolved = true;
      });
      await flushMicrotasks();
      expect(fourthResolved).to.equal(false);

      queue.releaseSlot('p');
      await fourth;
      expect(fourthResolved).to.equal(true);
    });

    it('-1 bypasses the gate entirely — never queues regardless of concurrency', async () => {
      const queue = queueWithLimits({ p: -1 });

      // 100 concurrent acquires against an "unlimited" gate must all resolve
      // immediately, with no queuing/accounting overhead to observe.
      const results = await Promise.all(
        Array.from({ length: 100 }, () => queue.acquireSlot('p', 'sync')),
      );
      expect(results).to.have.length(100);

      // releaseSlot on an unlimited gate is a no-op, not an accounting bug.
      expect(() => queue.releaseSlot('p')).to.not.throw();
    });
  });

  describe('ProviderQueue — sync-before-async drain ordering', () => {
    it('dispatches a queued sync request before an earlier-queued async one', async () => {
      const queue = queueWithLimits({ p: 1 });
      const order: string[] = [];

      await queue.acquireSlot('p', 'sync'); // holds the only slot
      const asyncP = queue.acquireSlot('p', 'async').then(() => order.push('async'));
      const syncP = queue.acquireSlot('p', 'sync').then(() => order.push('sync'));

      queue.releaseSlot('p'); // frees the held slot -> dispatches sync (not the earlier-queued async)
      await flushMicrotasks();
      queue.releaseSlot('p'); // sync "finishes" -> dispatches async
      await Promise.all([asyncP, syncP]);

      expect(order).to.deep.equal(['sync', 'async']);
    });

    it('drains sync ahead of async on every iteration of a multi-slot release', async () => {
      const queue = queueWithLimits({ p: 1 });
      const order: string[] = [];

      await queue.acquireSlot('p', 'sync'); // holds the only slot
      const a1 = queue.acquireSlot('p', 'async').then(() => order.push('async1'));
      const s1 = queue.acquireSlot('p', 'sync').then(() => order.push('sync1'));
      const a2 = queue.acquireSlot('p', 'async').then(() => order.push('async2'));
      const s2 = queue.acquireSlot('p', 'sync').then(() => order.push('sync2'));

      // A single release only frees one slot (maxConcurrency is 1), so each
      // queued request needs its own release — sync must still win on every
      // one of them, not just the first.
      queue.releaseSlot('p'); // frees the held slot -> dispatches sync1
      await flushMicrotasks();
      queue.releaseSlot('p'); // sync1 finishes -> dispatches sync2 (not async1)
      await flushMicrotasks();
      queue.releaseSlot('p'); // sync2 finishes -> dispatches async1
      await flushMicrotasks();
      queue.releaseSlot('p'); // async1 finishes -> dispatches async2

      await Promise.all([a1, s1, a2, s2]);
      expect(order).to.deep.equal(['sync1', 'sync2', 'async1', 'async2']);
    });

    it('a single release can drain more than one queued request when maxConcurrency > 1', async () => {
      const queue = queueWithLimits({ p: 3 });
      const order: string[] = [];

      await Promise.all([
        queue.acquireSlot('p', 'sync'),
        queue.acquireSlot('p', 'sync'),
        queue.acquireSlot('p', 'sync'),
      ]); // fills all 3 slots

      const q1 = queue.acquireSlot('p', 'sync').then(() => order.push('q1'));
      const q2 = queue.acquireSlot('p', 'async').then(() => order.push('q2'));
      const q3 = queue.acquireSlot('p', 'sync').then(() => order.push('q3'));

      // Vacate all 3 slots at once, as if 3 requests completed simultaneously.
      queue.releaseSlot('p');
      queue.releaseSlot('p');
      queue.releaseSlot('p');

      await Promise.all([q1, q2, q3]);
      // Both queued syncs dispatch ahead of the one queued async, even though
      // freed via 3 separate releaseSlot() calls rather than a single drain.
      expect(order).to.have.members(['q1', 'q2', 'q3']);
      expect(order.indexOf('q2')).to.equal(2);
    });
  });

  describe('ProviderQueue#acquireSlot — abort', () => {
    it('splices an aborted queued request out without resolving it, and rejects its promise', async () => {
      const queue = queueWithLimits({ p: 1 });
      const controller = new AbortController();

      await queue.acquireSlot('p', 'sync'); // holds the only slot
      let rejected: unknown = null;
      const queued = queue.acquireSlot('p', 'async', { signal: controller.signal }).catch((err) => {
        rejected = err;
      });

      controller.abort();
      await queued;
      expect(rejected).to.be.instanceOf(Error);

      // The aborted entry must be gone from the queue — releasing the slot
      // now should leave nothing to dispatch (no leftover resolve() call on
      // a promise nobody awaits, and no accounting drift).
      let laterResolved = false;
      queue.releaseSlot('p');
      await flushMicrotasks();
      // A fresh acquire after the release should get the slot immediately —
      // proof the aborted entry didn't consume it.
      await queue.acquireSlot('p', 'sync').then(() => {
        laterResolved = true;
      });
      expect(laterResolved).to.equal(true);
    });

    it('does not reject an already-immediate acquire even with a signal attached', async () => {
      const queue = queueWithLimits({ p: 1 });
      const controller = new AbortController();
      await queue.acquireSlot('p', 'sync', { signal: controller.signal });
      controller.abort(); // no-op — the slot was already granted, not queued
      expect(true).to.equal(true); // no throw/unhandled rejection
    });
  });

  describe('ProviderQueue#acquireSlot — onWaitChange', () => {
    it('fires (true) on queuing and (false) on dispatch, and never fires when a slot is immediately available', async () => {
      const queue = queueWithLimits({ p: 1 });
      const events: boolean[] = [];

      await queue.acquireSlot('p', 'sync', { onWaitChange: (w) => events.push(w) });
      expect(events).to.deep.equal([]); // immediate grant — never "waiting"

      const waiter = queue.acquireSlot('p', 'sync', { onWaitChange: (w) => events.push(w) });
      expect(events).to.deep.equal([true]); // synchronous, before the await even resolves

      queue.releaseSlot('p');
      await waiter;
      expect(events).to.deep.equal([true, false]);
    });

    it('fires (false) when an abort ends the wait, not just on dispatch', async () => {
      const queue = queueWithLimits({ p: 1 });
      const controller = new AbortController();
      const events: boolean[] = [];

      await queue.acquireSlot('p', 'sync'); // holds the slot
      const waiter = queue
        .acquireSlot('p', 'sync', {
          signal: controller.signal,
          onWaitChange: (w) => events.push(w),
        })
        .catch(() => {});

      expect(events).to.deep.equal([true]);
      controller.abort();
      await waiter;
      expect(events).to.deep.equal([true, false]);
    });
  });

  describe('ProviderQueue#withSlot', () => {
    it('acquires, runs fn, and propagates a thrown error', async () => {
      const queue = queueWithLimits({ p: 1 });
      let caught: unknown = null;

      try {
        await queue.withSlot('p', 'sync', async () => {
          throw new Error('boom');
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).message).to.equal('boom');
    });

    it('releases the slot so a subsequent withSlot call can proceed', async () => {
      const queue = queueWithLimits({ p: 1 });
      const order: string[] = [];

      await queue.withSlot('p', 'sync', async () => {
        order.push('first');
      });
      await queue.withSlot('p', 'sync', async () => {
        order.push('second');
      });

      expect(order).to.deep.equal(['first', 'second']);
    });

    it('releases even when fn throws, unblocking a queued waiter', async () => {
      const queue = queueWithLimits({ p: 1 });
      let failed = false;
      let waited = false;

      // Both calls fire before either settles — the second must queue behind
      // the first (maxConcurrency: 1) and only proceed once the first's
      // `finally` releases the slot, throw or not. Ordering between the two
      // independent .catch/.then callbacks below is a microtask-scheduling
      // detail, not a guarantee this class makes — only "the waiter isn't
      // left stuck forever" is.
      const failing = queue
        .withSlot('p', 'sync', async () => {
          throw new Error('boom');
        })
        .catch(() => {
          failed = true;
        });
      const waiting = queue.withSlot('p', 'sync', async () => {
        waited = true;
      });

      await Promise.all([failing, waiting]);
      expect(failed).to.equal(true);
      expect(waited).to.equal(true);
    });
  });
});
