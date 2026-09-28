import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { bootWakeupStore, getWakeupStore, WAKEUP_MAX_CHAIN } from '../../services/wakeup-store.js';
import { bootWakeupRegistry, getWakeupRegistry } from '../../services/wakeup-registry.js';
import { scheduleWakeupTool } from './schedule-wakeup.tool.js';
import { cancelWakeupTool } from './cancel-wakeup.tool.js';

const THREAD_ID = 'wakeup-tool-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(configurable: Record<string, unknown> = { thread_id: THREAD_ID }): any {
  return { configurable, toolCallId: 'call-1' };
}

describe('agents/tools/schedule_wakeup + cancel_wakeup', () => {
  let dir: string;
  let armed: number[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wakeup-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    bootWakeupStore(db);
    armed = [];
    // Timers are recorded, never run — these tests are about the tools.
    bootWakeupRegistry({
      setTimer: (_fn, ms) => armed.push(ms),
      clearTimer: () => {},
      deliver: () => {},
    });
    getThreadStore().upsertThreadOnFirstMessage(THREAD_ID, 'deploy', 'chat');
  });

  afterEach(() => {
    getWakeupRegistry().stop();
    getThreadStore().close();
    rmSync(dir, { recursive: true, force: true });
  });

  const schedule = (delaySeconds: number, note = 'Run kubectl rollout status deploy/api') =>
    scheduleWakeupTool.invoke({ delaySeconds, note }, invokeConfig());

  describe('schedule_wakeup', () => {
    it('schedules a pending wake-up, arms its timer and tells the agent to end its turn [orchestration]', async () => {
      const result = await schedule(900);

      const pending = getWakeupStore().getPending(THREAD_ID);
      expect(pending).to.include({ note: 'Run kubectl rollout status deploy/api', chainDepth: 1 });
      expect(armed).to.have.length(1);
      expect(armed[0]).to.be.closeTo(900_000, 5_000);
      expect(String(result)).to.include('in 15m');
      expect(String(result)).to.include('End your turn now');
    });

    it('refuses a delay under 10s, which would just burn provider slots in a tight loop [unit]', async () => {
      const result = await schedule(5);
      expect(String(result)).to.include('between 10 and 7200');
      expect(getWakeupStore().getPending(THREAD_ID)).to.equal(null);
    });

    it('refuses a delay over 2h and points at scheduled tasks instead [unit]', async () => {
      const result = await schedule(3 * 3600);
      expect(String(result)).to.include('scheduled task');
      expect(getWakeupStore().getPending(THREAD_ID)).to.equal(null);
    });

    it('refuses an empty note, since the resumed agent would not know what to check [unit]', async () => {
      const result = await schedule(60, '   ');
      expect(String(result)).to.include('note is required');
    });

    it('refuses a second wake-up while one is pending and names cancel_wakeup [unit]', async () => {
      await schedule(60);
      const result = await schedule(120, 'another');
      expect(String(result)).to.include('already pending');
      expect(String(result)).to.include('cancel_wakeup');
    });

    it('records chain depth one deeper than the wake-up turn that scheduled it [unit]', async () => {
      await scheduleWakeupTool.invoke(
        { delaySeconds: 60, note: 'poll again' },
        invokeConfig({ thread_id: THREAD_ID, wakeupDepth: 4 }),
      );
      expect(getWakeupStore().getPending(THREAD_ID)?.chainDepth).to.equal(5);
    });

    it(`stops a self-wake chain after ${WAKEUP_MAX_CHAIN} wake-ups and tells the agent to report back [unit]`, async () => {
      const result = await scheduleWakeupTool.invoke(
        { delaySeconds: 60, note: 'poll again' },
        invokeConfig({ thread_id: THREAD_ID, wakeupDepth: WAKEUP_MAX_CHAIN }),
      );
      expect(String(result)).to.include('report the current status to the user');
      expect(getWakeupStore().getPending(THREAD_ID)).to.equal(null);
    });

    it('explains itself when there is no thread to resume [unit]', async () => {
      const result = await scheduleWakeupTool.invoke(
        { delaySeconds: 60, note: 'x' },
        invokeConfig({}),
      );
      expect(String(result)).to.include('no active thread');
    });
  });

  describe('cancel_wakeup', () => {
    it("cancels the thread's pending wake-up with the agent's reason [orchestration]", async () => {
      await schedule(900);
      const { id } = getWakeupStore().getPending(THREAD_ID)!;

      const result = await cancelWakeupTool.invoke(
        { reason: 'deploy finished early' },
        invokeConfig(),
      );

      expect(String(result)).to.equal('Cancelled the pending wake-up.');
      expect(getWakeupStore().get(id)).to.include({
        status: 'cancelled',
        settledBy: 'agent_cancel',
        cancelReason: 'deploy finished early',
      });
    });

    it('says so when nothing is pending [unit]', async () => {
      const result = await cancelWakeupTool.invoke({}, invokeConfig());
      expect(String(result)).to.equal('No wake-up is pending in this thread.');
    });
  });
});
