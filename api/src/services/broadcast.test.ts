import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  registerBroadcastClient,
  unregisterBroadcastClient,
  broadcast,
  _clientCount,
} from './broadcast.js';

describe('services/broadcast', () => {
  const registered: Array<(event: unknown) => void> = [];

  afterEach(() => {
    for (const writer of registered.splice(0)) {
      unregisterBroadcastClient(writer as never);
    }
  });

  function makeWriter() {
    const calls: unknown[] = [];
    const writer = (event: unknown) => calls.push(event);
    registered.push(writer);
    return { writer, calls };
  }

  it('delivers a broadcast event to a registered writer [unit]', () => {
    const { writer, calls } = makeWriter();
    registerBroadcastClient(writer as never);

    const event = { type: 'hitl_prompt' as const, threadId: 't1', taskId: 'task1' };
    broadcast(event);

    expect(calls).to.deep.equal([event]);
  });

  it('stops delivering to a writer once unregistered [unit]', () => {
    const { writer, calls } = makeWriter();
    registerBroadcastClient(writer as never);
    unregisterBroadcastClient(writer as never);

    broadcast({ type: 'hitl_prompt', threadId: 't1', taskId: 'task1' });

    expect(calls).to.deep.equal([]);
  });

  it('delivers the same event to every registered writer (multi-tab fan-out) [unit]', () => {
    const a = makeWriter();
    const b = makeWriter();
    const c = makeWriter();
    registerBroadcastClient(a.writer as never);
    registerBroadcastClient(b.writer as never);
    registerBroadcastClient(c.writer as never);

    const event = {
      type: 'task_completed' as const,
      threadId: 't1',
      taskId: 'task1',
      outcome: 'done' as const,
    };
    broadcast(event);

    expect(a.calls).to.deep.equal([event]);
    expect(b.calls).to.deep.equal([event]);
    expect(c.calls).to.deep.equal([event]);
  });

  it('does not throw when broadcasting with zero registered clients [unit]', () => {
    expect(() =>
      broadcast({ type: 'task_completed', threadId: 't1', taskId: 'task1', outcome: 'failed' }),
    ).to.not.throw();
  });

  it('_clientCount reflects register/unregister [unit]', () => {
    const before = _clientCount();
    const { writer } = makeWriter();
    registerBroadcastClient(writer as never);
    expect(_clientCount()).to.equal(before + 1);

    unregisterBroadcastClient(writer as never);
    expect(_clientCount()).to.equal(before);
  });
});
