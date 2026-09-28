import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { bootWakeupStore, getWakeupStore, type Wakeup } from '../../services/wakeup-store.js';
import { bootWakeupRegistry, getWakeupRegistry } from '../../services/wakeup-registry.js';
import { startTestServer } from '../../../tests/utilities/http-test-server.js';
import { threadsRouter } from './threads.route.js';

// Wiring for the wake-up card's Cancel / Trigger now routes — the handler
// and registry are unit-tested on their own; this proves the route composes
// them and returns the updated card.
describe('routes/v1/threads — wake-up card actions', () => {
  let dir: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  let delivered: Wakeup[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'threads-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    bootWakeupStore(db);
    delivered = [];
    bootWakeupRegistry({
      setTimer: () => 0,
      clearTimer: () => {},
      deliver: (wakeup) => {
        delivered.push(wakeup);
      },
    });
    getThreadStore().upsertThreadOnFirstMessage('t1', 'deploy', 'chat');
    ({ baseUrl, close } = await startTestServer(threadsRouter, '/api/v1/threads'));
  });

  afterEach(async () => {
    await close();
    getWakeupRegistry().stop();
    getThreadStore().close();
    rmSync(dir, { recursive: true, force: true });
  });

  const schedule = () =>
    getWakeupStore().schedule({
      threadId: 't1',
      note: 'check the deploy',
      fireAt: new Date(Date.now() + 900_000),
      chainDepth: 1,
    });

  const post = (path: string) => fetch(`${baseUrl}${path}`, { method: 'POST' });

  it('Cancel settles the wake-up and returns the updated card [orchestration]', async () => {
    const wakeup = schedule();

    const res = await post(`/t1/wakeups/${wakeup.id}/cancel`);

    expect(res.status).to.equal(200);
    expect(await res.json()).to.include({
      wakeupId: wakeup.id,
      state: 'cancelled',
      settledBy: 'user_cancel',
    });
    expect(delivered).to.have.length(0);
  });

  it('Trigger now fires the wake-up, starts its turn, and returns the updated card [orchestration]', async () => {
    const wakeup = schedule();

    const res = await post(`/t1/wakeups/${wakeup.id}/trigger`);

    expect(res.status).to.equal(200);
    expect(await res.json()).to.include({ state: 'fired', settledBy: 'trigger_now' });
    expect(delivered.map((w) => w.id)).to.deep.equal([wakeup.id]);
  });

  it('409s an action on a wake-up that already settled [orchestration]', async () => {
    const wakeup = schedule();
    await post(`/t1/wakeups/${wakeup.id}/cancel`);

    const res = await post(`/t1/wakeups/${wakeup.id}/trigger`);

    expect(res.status).to.equal(409);
    expect(delivered).to.have.length(0);
  });

  it('404s a wake-up id from another thread [orchestration]', async () => {
    getThreadStore().upsertThreadOnFirstMessage('t2', 'other', 'chat');
    const wakeup = schedule();

    const res = await post(`/t2/wakeups/${wakeup.id}/cancel`);

    expect(res.status).to.equal(404);
    expect(getWakeupStore().get(wakeup.id)?.status).to.equal('pending');
  });
});
