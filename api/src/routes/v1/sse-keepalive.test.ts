import { EventEmitter } from 'node:events';
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { startSseKeepalive, SSE_KEEPALIVE_MS } from './sse-keepalive.js';

// A Response stand-in: records writes and can emit 'close' like a client
// disconnect. Only the members startSseKeepalive touches.
class FakeRes extends EventEmitter {
  writes: string[] = [];
  writableEnded = false;
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

// Manual interval driver — tick() runs every live interval callback once.
class FakeIntervals {
  private next = 1;
  readonly live = new Map<number, { fn: () => void; ms: number }>();
  setInterval = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.live.set(id, { fn, ms });
    return id;
  };
  clearInterval = (handle: unknown): void => {
    this.live.delete(handle as number);
  };
  tick(): void {
    for (const { fn } of [...this.live.values()]) fn();
  }
}

describe('routes/v1/sse-keepalive', () => {
  let res: FakeRes;
  let timers: FakeIntervals;

  beforeEach(() => {
    res = new FakeRes();
    timers = new FakeIntervals();
  });

  function start(): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return startSseKeepalive(res as any, {
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
  }

  it('writes an SSE comment line on each interval, which clients ignore as data [unit]', () => {
    start();
    timers.tick();
    timers.tick();
    expect(res.writes).to.deep.equal([': keepalive\n\n', ': keepalive\n\n']);
  });

  it('defaults to an interval well below browser/proxy idle timeouts [unit]', () => {
    start();
    const [{ ms }] = [...timers.live.values()];
    expect(ms).to.equal(SSE_KEEPALIVE_MS);
    expect(ms).to.be.at.most(30_000);
  });

  it('stops writing once the returned stop function is called at the end of the turn [unit]', () => {
    const stop = start();
    stop();
    timers.tick();
    expect(res.writes).to.deep.equal([]);
    expect(timers.live.size).to.equal(0);
  });

  it('stops by itself when the client disconnects, so no timer outlives the request [unit]', () => {
    start();
    res.emit('close');
    timers.tick();
    expect(res.writes).to.deep.equal([]);
    expect(timers.live.size).to.equal(0);
  });

  it('never writes to a response that has already ended [unit]', () => {
    start();
    res.writableEnded = true;
    timers.tick();
    expect(res.writes).to.deep.equal([]);
  });

  it('tolerates stop being called both on close and in the route finally block [unit]', () => {
    const stop = start();
    res.emit('close');
    expect(() => stop()).not.to.throw();
  });
});
