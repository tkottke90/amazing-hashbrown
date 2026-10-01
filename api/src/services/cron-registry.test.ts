import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from './workspace-store.js';
import { CronRegistry, MAX_TIMER_DELAY_MS, withCronResync } from './cron-registry.js';

// A hand-rolled fake clock + timer queue (the repo has no sinon): timers
// only run when advance() moves the clock past them.
class FakeClock {
  private nowMs: number;
  private nextId = 1;
  timers = new Map<number, { fn: () => void; at: number; ms: number }>();

  constructor(iso: string) {
    this.nowMs = new Date(iso).getTime();
  }

  now = () => new Date(this.nowMs);

  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.nowMs + ms, ms });
    return id;
  };

  clearTimer = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  set(iso: string) {
    this.nowMs = new Date(iso).getTime();
  }

  // Moves the clock to `iso`, running every timer that comes due on the way,
  // in order, with the clock set to each timer's own due time.
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

const REPEAT_CONFIG = {
  expression: '0 0 * * *',
  timezone: 'UTC',
  enabled: true,
  maxIterations: null,
  stopAfter: null,
  maxConsecutiveFailures: 3,
  enabledAt: '2026-09-01T00:00:00.000Z',
  lastFiredAt: null,
  consecutiveFailures: 0,
  pausedReason: null,
};

describe('services/cron-registry', () => {
  let dir: string;
  let store: WorkspaceStore;
  let clock: FakeClock;
  let wakes: number;
  let registry: CronRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cron-registry-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    clock = new FakeClock('2026-09-26T12:00:00.000Z');
    wakes = 0;
    registry = new CronRegistry({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      store: () => store,
      onEnqueued: () => {
        wakes++;
      },
    });
  });

  afterEach(() => {
    registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function repeatTask(overrides: Record<string, unknown> = {}) {
    const task = store.createTask({
      title: 'nightly',
      triggerType: 'cron_repeat',
      triggerConfig: { ...REPEAT_CONFIG, ...overrides },
    });
    return store.patchTask(task.id, { status: 'scheduled' })!;
  }

  function onceTask(fireAt: string, overrides: Record<string, unknown> = {}) {
    const task = store.createTask({
      title: 'one-shot',
      triggerType: 'cron_once',
      triggerConfig: {
        fireAt,
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-09-01T00:00:00.000Z',
        lastFiredAt: null,
        ...overrides,
      },
    });
    return store.patchTask(task.id, { status: 'scheduled' })!;
  }

  function runsOf(taskId: string) {
    return store.listTaskRuns(taskId, {});
  }

  describe('sync() and firing', () => {
    it('arms the next fire time and starts a scheduled run when it comes [orchestration]', () => {
      const task = repeatTask();
      registry.sync(task.id);
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');

      clock.advanceTo('2026-09-27T00:00:01.000Z');

      const runs = runsOf(task.id);
      expect(runs).to.have.length(1);
      expect(runs[0]).to.include({
        triggerSource: 'schedule',
        scheduledFor: '2026-09-27T00:00:00.000Z',
      });
      expect(store.getTask(task.id)!.status).to.equal('ready');
      expect(wakes, 'the scheduler is woken so the run starts now').to.equal(1);
    });

    it('re-arms for the following fire time once the run settles back to scheduled [orchestration]', () => {
      const task = repeatTask();
      registry.sync(task.id);
      clock.advanceTo('2026-09-27T00:00:01.000Z');

      const entry = store.dequeueNext()!;
      store.completeQueueEntry(entry.id, 'done');
      registry.sync(task.id);

      expect(store.getTask(task.id)!.status).to.equal('scheduled');
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-28T00:00:00.000Z');
    });

    it('skips a fire while the task is still busy, rather than queueing a second run [orchestration]', () => {
      const task = repeatTask();
      registry.sync(task.id);
      store.patchTask(task.id, { status: 'running' });

      clock.advanceTo('2026-09-27T00:00:01.000Z');

      expect(runsOf(task.id)).to.have.length(0);
      expect(wakes).to.equal(0);
      expect(registry.armedFor(task.id), 'nothing is armed until the task settles').to.equal(null);
    });

    it('arms nothing for a turned-off schedule or a task not at scheduled [orchestration]', () => {
      const off = repeatTask({ enabled: false });
      const pending = store.createTask({
        title: 'not yet',
        triggerType: 'cron_repeat',
        triggerConfig: REPEAT_CONFIG,
      });
      registry.sync(off.id);
      registry.sync(pending.id);
      expect(registry.armedFor(off.id)).to.equal(null);
      expect(registry.armedFor(pending.id)).to.equal(null);
    });

    it('resyncAll() arms a task it has never synced before, not just ones in its own timer map [orchestration]', () => {
      const task = repeatTask();
      expect(registry.armedFor(task.id), 'sanity: nothing armed for it yet').to.equal(null);

      registry.resyncAll();

      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');
    });

    it('follows an edited schedule and drops a deleted task [orchestration]', () => {
      const task = repeatTask();
      registry.sync(task.id);

      store.patchTask(task.id, { triggerConfig: { ...REPEAT_CONFIG, expression: '0 18 * * *' } });
      registry.sync(task.id);
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-26T18:00:00.000Z');

      store.deleteTask(task.id);
      registry.resyncAll();
      expect(registry.armedFor(task.id)).to.equal(null);
      expect(clock.timers.size, 'the timer is cleared, not left to fire').to.equal(0);
    });

    it('re-arms instead of firing when a timer wakes early [orchestration]', () => {
      const task = repeatTask();
      registry.fire(task.id, new Date('2026-09-27T00:00:00.000Z'), 'schedule');

      expect(runsOf(task.id)).to.have.length(0);
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');
    });

    it('splits a wait longer than setTimeout allows into chunks, firing only at the real time [orchestration]', () => {
      const task = repeatTask({ expression: '0 0 1 1 *' }); // next: 2027-01-01, ~97 days out
      registry.sync(task.id);
      const [first] = [...clock.timers.values()];
      expect(first!.ms).to.equal(MAX_TIMER_DELAY_MS);

      clock.advanceTo('2026-12-31T23:59:59.000Z');
      expect(runsOf(task.id), 'no run from an intermediate chunk').to.have.length(0);

      clock.advanceTo('2027-01-01T00:00:01.000Z');
      expect(runsOf(task.id)).to.have.length(1);
    });

    it('fires a one-shot that came due while it was busy with a manual run [orchestration]', () => {
      const task = onceTask('2026-09-26T13:00:00.000Z');
      store.patchTask(task.id, { status: 'running' });
      clock.set('2026-09-26T14:00:00.000Z');
      store.patchTask(task.id, { status: 'scheduled' });

      registry.sync(task.id);

      const runs = runsOf(task.id);
      expect(runs).to.have.length(1);
      expect(runs[0]).to.include({
        triggerSource: 'catch_up',
        scheduledFor: '2026-09-26T13:00:00.000Z',
      });
    });
  });

  describe('boot()', () => {
    it('catches up once for many missed fire times, then arms the next one [orchestration]', () => {
      const task = repeatTask({ lastFiredAt: '2026-09-20T00:00:00.000Z' });

      registry.boot();

      const runs = runsOf(task.id);
      expect(runs, 'one catch-up run, not a backlog of six').to.have.length(1);
      expect(runs[0]).to.include({
        triggerSource: 'catch_up',
        scheduledFor: '2026-09-26T00:00:00.000Z',
      });
      expect(wakes).to.equal(1);

      const entry = store.dequeueNext()!;
      store.completeQueueEntry(entry.id, 'done');
      registry.sync(task.id);
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');
    });

    it('only arms a task that missed nothing while the server was down [orchestration]', () => {
      const task = repeatTask({ lastFiredAt: '2026-09-26T00:00:00.000Z' });
      registry.boot();
      expect(runsOf(task.id)).to.have.length(0);
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');
    });

    it('fires a one-shot late when its time passed while the server was down [orchestration]', () => {
      const task = onceTask('2026-09-26T06:00:00.000Z');
      registry.boot();
      expect(runsOf(task.id)[0]).to.include({ triggerSource: 'catch_up' });
    });
  });

  describe('withCronResync()', () => {
    it('re-arms the schedule after a run, even when the executor throws [orchestration]', async () => {
      const task = repeatTask();
      registry.fire(task.id, new Date('2026-09-26T00:00:00.000Z'), 'catch_up');
      const entry = store.dequeueNext()!;

      const executor = withCronResync(
        async () => {
          store.completeQueueEntry(entry.id, 'failed');
          throw new Error('boom');
        },
        () => registry,
      );

      let thrown: unknown;
      try {
        await executor(entry);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'the executor error still propagates to the scheduler').to.be.instanceOf(
        Error,
      );
      expect(registry.armedFor(task.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');
    });

    it('also arms a dependent cron task the run just released into scheduled, not only the task that ran [orchestration]', async () => {
      const blocker = store.createTask({ title: 'blocker', assignedTo: 'agent' });
      store.patchTask(blocker.id, { status: 'ready' });
      const entry = store.enqueueTask(blocker.id);
      const dependent = store.createTask({
        title: 'nightly, gated on blocker',
        triggerType: 'cron_repeat',
        triggerConfig: REPEAT_CONFIG,
      });
      store.addTaskDependency(dependent.id, blocker.id);

      const executor = withCronResync(
        async () => {
          store.completeQueueEntry(entry.id, 'done');
        },
        () => registry,
      );
      await executor({ ...entry, task: store.getTask(blocker.id)! });

      expect(store.getTask(dependent.id)!.status).to.equal('scheduled');
      expect(registry.armedFor(dependent.id)?.toISOString()).to.equal('2026-09-27T00:00:00.000Z');
    });
  });
});
