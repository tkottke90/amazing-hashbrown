import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import {
  WorkspaceStore,
  bootWorkspaceStore,
  type Task,
  type TaskQueueEntry,
} from './workspace-store.js';
import { TaskScheduler } from './task-scheduler.js';

// Flushes enough microtask turns for a chain of `await this.executor(...)` →
// `catch`/`finally` → `this.wake()` → (possibly) another dispatch to settle,
// without a real timer or a mocking library — the repo's established
// approach (see scheduleResume()'s timer-spy below) is a hand-rolled seam,
// not a library, so this mirrors that.
function flushMicrotasks(times = 4): Promise<void> {
  return times <= 0 ? Promise.resolve() : Promise.resolve().then(() => flushMicrotasks(times - 1));
}

function makeStore(): { store: WorkspaceStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'task-scheduler-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new WorkspaceStore(db);
  // TaskScheduler reaches the store through the module-level singleton
  // (getWorkspaceStore()), same as the rest of the app wiring.
  bootWorkspaceStore(db);
  return { store, dir };
}

describe('services/task-scheduler', () => {
  let store: WorkspaceStore;
  let dir: string;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    ({ store, dir } = makeStore());
    scheduler = new TaskScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeQueuedTask(title: string) {
    const task = store.createTask({ title });
    return store.enqueueTask(task.id);
  }

  describe('start() / wake()', () => {
    it('picks up work already queued at boot, without polling', () => {
      makeQueuedTask('Boot-time task');
      expect(store.getRunningEntry()).to.equal(null);

      scheduler.start();

      const running = store.getRunningEntry();
      expect(running).to.not.equal(null);
      expect(running!.task.title).to.equal('Boot-time task');
    });

    it('is a no-op when the queue is empty', () => {
      scheduler.start();
      expect(store.getRunningEntry()).to.equal(null);
      expect(scheduler.isPaused()).to.equal(false);
    });

    it('does not start a second task while one is already running', () => {
      const first = makeQueuedTask('First');
      makeQueuedTask('Second');
      scheduler.wake();
      expect(store.getRunningEntry()!.id).to.equal(first.id);

      scheduler.wake();
      expect(store.getRunningEntry()!.id).to.equal(first.id);
    });
  });

  describe('pause()', () => {
    it('leaves an idle scheduler idle — no spurious task starts', () => {
      makeQueuedTask('Not started yet');
      scheduler.pause();

      expect(scheduler.isPaused()).to.equal(true);
      expect(store.getRunningEntry()).to.equal(null);
      // Still sitting pending, untouched.
      expect(store.listQueue().find((e) => e.status === 'pending')).to.not.equal(undefined);
    });

    it('re-queues a running task as paused rather than starting the next one', () => {
      const first = makeQueuedTask('Running');
      makeQueuedTask('Waiting');
      scheduler.wake();
      expect(store.getRunningEntry()!.id).to.equal(first.id);

      scheduler.pause();

      expect(scheduler.isPaused()).to.equal(true);
      expect(store.getRunningEntry()).to.equal(null);
      const entries = store.listQueue();
      expect(entries.find((e) => e.id === first.id)!.status).to.equal('paused');
      expect(entries.find((e) => e.status === 'pending')).to.not.equal(undefined);
    });

    it('does not dequeue new work enqueued while paused', () => {
      scheduler.pause();
      makeQueuedTask('Enqueued during pause');
      scheduler.wake();
      expect(store.getRunningEntry()).to.equal(null);
    });
  });

  describe('resume()', () => {
    it('returns an idle scheduler to idle — no spurious task start', () => {
      scheduler.pause();
      expect(scheduler.isPaused()).to.equal(true);

      scheduler.resume();

      expect(scheduler.isPaused()).to.equal(false);
      expect(store.getRunningEntry()).to.equal(null);
    });

    it('immediately picks the next task back up when work was pending', () => {
      const first = makeQueuedTask('Running');
      makeQueuedTask('Waiting');
      scheduler.wake();
      scheduler.pause();
      expect(store.getRunningEntry()).to.equal(null);

      scheduler.resume();

      expect(scheduler.isPaused()).to.equal(false);
      const running = store.getRunningEntry();
      expect(running).to.not.equal(null);
      // The entry that was running before the pause is re-queued at the
      // front of the line, so it's the one that resumes first.
      expect(running!.id).to.equal(first.id);
    });

    it('picks up a task enqueued only while paused', () => {
      scheduler.pause();
      const queued = makeQueuedTask('Enqueued during pause');

      scheduler.resume();

      const running = store.getRunningEntry();
      expect(running).to.not.equal(null);
      expect(running!.id).to.equal(queued.id);
    });
  });

  describe('isPaused()', () => {
    it('reflects pause/resume transitions', () => {
      expect(scheduler.isPaused()).to.equal(false);
      scheduler.pause();
      expect(scheduler.isPaused()).to.equal(true);
      scheduler.resume();
      expect(scheduler.isPaused()).to.equal(false);
    });
  });

  describe('scheduleResume()', () => {
    it('arms a timer that is cleared by a subsequent pause() (timer reset on new activity)', () => {
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      let scheduledCount = 0;
      let clearedCount = 0;
      // Lightweight timer spy — no sinon in this repo's toolchain, and a
      // real 30s wait is too slow for a unit test. We only need to confirm
      // scheduleResume() re-arms (and pause()/resume() clear) the timer,
      // not exercise the real delay.
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        scheduledCount++;
        return originalSetTimeout(fn, ms);
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
        clearedCount++;
        return originalClearTimeout(id);
      }) as typeof clearTimeout;

      try {
        scheduler.scheduleResume();
        expect(scheduledCount).to.equal(1);

        // A second chat message before the timer fires resets it.
        scheduler.pause();
        expect(clearedCount).to.equal(1);
        scheduler.scheduleResume();
        expect(scheduledCount).to.equal(2);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        scheduler.stop();
      }
    });
  });

  // Issue #87: tick() dispatches a constructor-injected TaskExecutor instead
  // of leaving a dequeued task parked in 'running' forever.
  describe('executor dispatch', () => {
    it('invokes the injected executor exactly once per dequeue, with the dequeued entry', () => {
      const calls: (TaskQueueEntry & { task: Task })[] = [];
      const fakeExecutor = async (entry: TaskQueueEntry & { task: Task }) => {
        calls.push(entry);
      };
      const s = new TaskScheduler(fakeExecutor);
      const queued = makeQueuedTask('Executor task');

      s.wake();

      expect(calls).to.have.length(1);
      expect(calls[0]!.id).to.equal(queued.id);
      expect(calls[0]!.task.title).to.equal('Executor task');
      // A second wake() while the first entry is still 'running' (the fake
      // executor's promise hasn't resolved and hasn't called
      // completeQueueEntry) must not dispatch again.
      s.wake();
      expect(calls).to.have.length(1);
      s.stop();
    });

    it('does not stop subsequent ticks when the executor rejects', async () => {
      let calls = 0;
      const fakeExecutor = async (entry: TaskQueueEntry & { task: Task }) => {
        calls++;
        // A real executor (task-execution.ts) always resolves the queue
        // entry itself, success or failure, before returning/throwing —
        // this fake mirrors that contract so the test isolates the
        // scheduler's own resilience, not a missing completeQueueEntry call.
        store.completeQueueEntry(entry.id, 'failed');
        throw new Error('boom');
      };
      const s = new TaskScheduler(fakeExecutor);
      makeQueuedTask('First');
      makeQueuedTask('Second');

      expect(() => s.wake()).to.not.throw();
      await flushMicrotasks();

      expect(calls).to.equal(2);
      s.stop();
    });

    it('leaves the entry running (and logs) rather than throwing when no executor is registered', () => {
      const s = new TaskScheduler();
      makeQueuedTask('No executor');

      expect(() => s.wake()).to.not.throw();
      expect(store.getRunningEntry()).to.not.equal(null);
      s.stop();
    });
  });
});
