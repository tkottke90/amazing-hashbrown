import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { setActiveSseWriter, clearActiveSseWriter } from './active-sse-writer.js';
import {
  enqueuePendingTurn,
  drainPendingTurns,
  runOnceThreadFree,
} from './pending-thread-turns.js';

const THREAD_ID = 'pending-turns-test-thread';

describe('agents/pending-thread-turns', () => {
  afterEach(() => {
    clearActiveSseWriter(THREAD_ID);
  });

  it('runs immediately when the thread mutex is free', async () => {
    let ran = false;
    enqueuePendingTurn(THREAD_ID, async () => {
      ran = true;
    });
    // enqueuePendingTurn fires synchronously (void run()) when free — no
    // await needed to observe the effect.
    expect(ran).to.equal(true);
  });

  it('queues instead of running when the thread mutex is held, and delivers exactly once on drain', async () => {
    setActiveSseWriter(THREAD_ID, () => {});

    let ran = false;
    let resolveRun: () => void = () => {};
    const ranPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    enqueuePendingTurn(THREAD_ID, async () => {
      ran = true;
      resolveRun();
    });

    // Still held — must not have run yet.
    expect(ran).to.equal(false);

    clearActiveSseWriter(THREAD_ID);
    drainPendingTurns(THREAD_ID);
    await ranPromise;

    expect(ran).to.equal(true);
  });

  it('delivers multiple queued turns for the same thread in FIFO order', async () => {
    setActiveSseWriter(THREAD_ID, () => {});

    const order: number[] = [];
    const done: Array<() => void> = [];
    const promises = [1, 2, 3].map(
      (n) =>
        new Promise<void>((resolve) => {
          done.push(resolve);
          enqueuePendingTurn(THREAD_ID, async () => {
            order.push(n);
            resolve();
          });
        }),
    );

    clearActiveSseWriter(THREAD_ID);
    drainPendingTurns(THREAD_ID); // delivers #1, whose caller must drain the next
    await promises[0];
    drainPendingTurns(THREAD_ID); // simulates #1's own clearActiveSseWriter+drain
    await promises[1];
    drainPendingTurns(THREAD_ID);
    await promises[2];

    expect(order).to.deep.equal([1, 2, 3]);
  });

  it('drainPendingTurns() is a no-op when nothing is queued for that thread', () => {
    expect(() => drainPendingTurns('no-such-thread')).to.not.throw();
  });

  // runOnceThreadFree() — the awaitable counterpart task-execution.ts's
  // executeTask() uses, so its caller doesn't resolve until the deferred
  // work has actually run (unlike enqueuePendingTurn's fire-and-forget).
  describe('runOnceThreadFree', () => {
    it('resolves once run() settles when the thread is free', async () => {
      let ran = false;
      await runOnceThreadFree(THREAD_ID, async () => {
        ran = true;
      });
      expect(ran).to.equal(true);
    });

    it('stays pending while the thread is busy, then resolves once cleared and drained', async () => {
      setActiveSseWriter(THREAD_ID, () => {});

      let ran = false;
      let settled = false;
      const p = runOnceThreadFree(THREAD_ID, async () => {
        ran = true;
      });
      p.then(() => {
        settled = true;
      });

      // Give any stray microtask a chance to run — still held, must not
      // have started yet.
      await Promise.resolve();
      expect(ran).to.equal(false);
      expect(settled).to.equal(false);

      clearActiveSseWriter(THREAD_ID);
      drainPendingTurns(THREAD_ID);
      await p;

      expect(ran).to.equal(true);
      expect(settled).to.equal(true);
    });

    it('propagates a rejection from run() when the thread was free', async () => {
      let caught: unknown;
      try {
        await runOnceThreadFree(THREAD_ID, async () => {
          throw new Error('boom');
        });
      } catch (err) {
        caught = err;
      }
      expect((caught as Error)?.message).to.equal('boom');
    });

    it('propagates a rejection from run() when the thread was busy (deferred)', async () => {
      setActiveSseWriter(THREAD_ID, () => {});

      const p = runOnceThreadFree(THREAD_ID, async () => {
        throw new Error('deferred boom');
      });

      clearActiveSseWriter(THREAD_ID);
      drainPendingTurns(THREAD_ID);

      let caught: unknown;
      try {
        await p;
      } catch (err) {
        caught = err;
      }
      expect((caught as Error)?.message).to.equal('deferred boom');
    });

    it('preserves FIFO ordering when mixed with a plain enqueuePendingTurn caller on the same thread', async () => {
      setActiveSseWriter(THREAD_ID, () => {});

      const order: string[] = [];
      const firstDone = new Promise<void>((resolve) => {
        enqueuePendingTurn(THREAD_ID, async () => {
          order.push('fire-and-forget');
          resolve();
        });
      });
      const second = runOnceThreadFree(THREAD_ID, async () => {
        order.push('awaitable');
      });

      clearActiveSseWriter(THREAD_ID);
      drainPendingTurns(THREAD_ID); // delivers the first queued turn
      await firstDone;
      drainPendingTurns(THREAD_ID); // simulates the first turn's own clear+drain
      await second;

      expect(order).to.deep.equal(['fire-and-forget', 'awaitable']);
    });
  });
});
