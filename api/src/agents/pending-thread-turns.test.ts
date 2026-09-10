import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { setActiveSseWriter, clearActiveSseWriter } from './active-sse-writer.js';
import { enqueuePendingTurn, drainPendingTurns } from './pending-thread-turns.js';

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
});
