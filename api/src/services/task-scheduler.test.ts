import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore, bootWorkspaceStore } from './workspace-store.js';
import { TaskScheduler } from './task-scheduler.js';

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
});
