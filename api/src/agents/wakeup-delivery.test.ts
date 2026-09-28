import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { bootWakeupStore, getWakeupStore, type Wakeup } from '../services/wakeup-store.js';
import { setActiveSseWriter, clearActiveSseWriter } from './active-sse-writer.js';
import { drainPendingTurns } from './pending-thread-turns.js';
import type { HeadlessAgent, HeadlessTurnParams } from './headless-turn.js';
import { buildWakeupMessage, deliverWakeup, formatElapsed } from './wakeup-delivery.js';

const SCHEDULED_AT = '2026-09-27T12:00:00.000Z';

function wakeupFixture(overrides: Partial<Wakeup> = {}): Wakeup {
  return {
    id: 'w1',
    threadId: 'thread-1',
    note: 'Run kubectl rollout status deploy/api',
    fireAt: '2026-09-27T12:15:00.000Z',
    status: 'fired',
    chainDepth: 2,
    createdAt: SCHEDULED_AT,
    settledAt: '2026-09-27T12:15:00.000Z',
    settledBy: 'timer',
    cancelReason: null,
    ...overrides,
  };
}

describe('agents/wakeup-delivery', () => {
  describe('formatElapsed', () => {
    const cases: Array<[number, string]> = [
      [45_000, '45s'],
      [15 * 60_000, '15m'],
      [65 * 60_000, '1h 5m'],
      [2 * 3_600_000, '2h'],
      [-5, '0s'],
    ];
    for (const [ms, text] of cases) {
      it(`formats ${ms}ms as ${text} [unit]`, () => {
        expect(formatElapsed(ms)).to.equal(text);
      });
    }
  });

  describe('buildWakeupMessage', () => {
    const at15m = new Date('2026-09-27T12:15:00.000Z');

    it('gives the agent its own note and how long it has been waiting [unit]', () => {
      const message = buildWakeupMessage(wakeupFixture(), 'timer', 0, at15m);
      expect(message).to.equal(
        '⏰ Wake-up (scheduled 15m ago). Your note: "Run kubectl rollout status deploy/api"\n' +
          'Continue from where you left off.',
      );
    });

    it('says when the user triggered it early, so the agent does not assume the wait elapsed [unit]', () => {
      const message = buildWakeupMessage(
        wakeupFixture(),
        'trigger_now',
        0,
        new Date('2026-09-27T12:03:00.000Z'),
      );
      expect(message).to.include('scheduled 3m ago');
      expect(message).to.include('The user triggered this wake-up early.');
    });

    it('says how late a catch-up fired, so the agent knows its check may be stale [unit]', () => {
      const message = buildWakeupMessage(
        wakeupFixture(),
        'catch_up',
        42 * 60_000,
        new Date('2026-09-27T12:57:00.000Z'),
      );
      expect(message).to.include('This fired 42m late because the server was offline.');
    });
  });

  describe('deliverWakeup', () => {
    let dir: string;
    let wakeup: Wakeup;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'wakeup-delivery-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      bootThreadStore(db);
      bootWakeupStore(db);
    });

    after(() => {
      getThreadStore().close();
      rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => clearActiveSseWriter('thread-1'));

    function scheduleAndFire(): Wakeup {
      getThreadStore().upsertThreadOnFirstMessage('thread-1', 'deploy', 'chat');
      const scheduled = getWakeupStore().schedule({
        threadId: 'thread-1',
        note: 'Run kubectl rollout status deploy/api',
        fireAt: new Date(Date.now() - 1000),
        chainDepth: 2,
      });
      return getWakeupStore().markFired(scheduled.id, 'timer')!;
    }

    const fakeAgent = { streamEvents: () => [], graph: {} } as unknown as HeadlessAgent;

    it('starts a wake-up turn on the thread model with the chain depth, after the fired marker [orchestration]', async () => {
      wakeup = scheduleAndFire();
      const calls: HeadlessTurnParams[] = [];
      let markerWrittenFirst = false;

      await deliverWakeup(wakeup, 'timer', 0, {
        resolveAgent: async () => ({ agent: fakeAgent, provider: 'p1', model: 'm1' }),
        runTurn: async (params) => {
          const kinds = getThreadStore()
            .getThread('thread-1')!
            .messages.map((m) => m.kind);
          markerWrittenFirst = kinds.at(-1) === 'wakeup_fired';
          calls.push(params);
        },
      });

      expect(calls).to.have.length(1);
      expect(calls[0]).to.include({
        threadId: 'thread-1',
        source: 'wakeup',
        wakeupDepth: 2,
        provider: 'p1',
        model: 'm1',
      });
      expect(calls[0]!.message).to.include('Your note: "Run kubectl rollout status deploy/api"');
      expect(markerWrittenFirst).to.equal(true);
    });

    it('queues behind a turn already running on the thread instead of racing it [orchestration]', async () => {
      wakeup = scheduleAndFire();
      setActiveSseWriter('thread-1', () => {});
      let ran = false;

      await deliverWakeup(wakeup, 'timer', 0, {
        resolveAgent: async () => ({ agent: fakeAgent }),
        runTurn: async () => {
          ran = true;
        },
      });
      expect(ran).to.equal(false);

      clearActiveSseWriter('thread-1');
      drainPendingTurns('thread-1');
      expect(ran).to.equal(true);
    });

    it('drops the turn quietly when the thread has no agent to resume (e.g. deleted) [unit]', async () => {
      wakeup = scheduleAndFire();
      let ran = false;

      await deliverWakeup(wakeup, 'timer', 0, {
        resolveAgent: async () => null,
        runTurn: async () => {
          ran = true;
        },
      });

      expect(ran).to.equal(false);
    });

    it('never rejects when resolving the agent fails [unit]', async () => {
      wakeup = scheduleAndFire();
      const outcome = await deliverWakeup(wakeup, 'timer', 0, {
        resolveAgent: async () => {
          throw new Error('provider not configured');
        },
      }).then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(outcome).to.equal('resolved');
    });
  });
});
