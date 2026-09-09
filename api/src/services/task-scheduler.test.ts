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
// without a real timer or a mocking library.
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
    rmSync(dir, { recursive: true, force: true });
  });

  function makeQueuedTask(title: string, workspaceId?: string | null) {
    const task = store.createTask({ title, workspaceId });
    return store.enqueueTask(task.id);
  }

  describe('start() / wake()', () => {
    it('picks up work already queued at boot, without polling', () => {
      makeQueuedTask('Boot-time task');
      expect(store.getRunningEntry('inbox')).to.equal(null);

      scheduler.start();

      const running = store.getRunningEntry('inbox');
      expect(running).to.not.equal(null);
      expect(running!.task.title).to.equal('Boot-time task');
    });

    it('is a no-op when the queue is empty', () => {
      scheduler.start();
      expect(store.getRunningEntry('inbox')).to.equal(null);
    });

    it('does not start a second task in the same scope while one is already running', () => {
      const first = makeQueuedTask('First');
      makeQueuedTask('Second');
      scheduler.wake();
      expect(store.getRunningEntry('inbox')!.id).to.equal(first.id);

      scheduler.wake();
      expect(store.getRunningEntry('inbox')!.id).to.equal(first.id);
    });

    it('dispatches tasks in different scopes concurrently from a single wake()', () => {
      const inboxTask = makeQueuedTask('Inbox task');
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const workspaceTask = makeQueuedTask('Workspace task', workspace.id);

      scheduler.wake();

      const runningInbox = store.getRunningEntry('inbox');
      const runningWorkspace = store.getRunningEntry(workspace.id);
      expect(runningInbox).to.not.equal(null);
      expect(runningInbox!.id).to.equal(inboxTask.id);
      expect(runningWorkspace).to.not.equal(null);
      expect(runningWorkspace!.id).to.equal(workspaceTask.id);
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
    });

    it('leaves the entry running (and logs) rather than throwing when no executor is registered', () => {
      const s = new TaskScheduler();
      makeQueuedTask('No executor');

      expect(() => s.wake()).to.not.throw();
      expect(store.getRunningEntry('inbox')).to.not.equal(null);
    });
  });
});
