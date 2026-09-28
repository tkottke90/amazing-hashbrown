import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore, type Task } from '../../services/workspace-store.js';
import { ThreadStore } from '../../services/thread-store.js';
import { recordHitlPrompt } from '../../agents/thread-message-writer.js';
import { registerTaskAbort, getTaskAbort, clearTaskAbort } from '../../agents/active-task-abort.js';
import { createTaskHandler } from './tasks.handlers.js';
import { buildBoardContexts, moveTaskHandler, withBoards } from './tasks-board.handlers.js';

enum TestTypes {
  UNIT = '[unit]',
}

// These drive POST /tasks/:id/move's handler against a real (temp) SQLite
// store: the rules themselves are pinned in board-rules.test.ts, so this
// file proves each kind of step actually lands the task in the state its
// lane promises — including the cron and dependency side effects a bare
// status patch would miss.
describe('routes/v1/tasks-board.handlers', () => {
  let store: WorkspaceStore;
  let threads: ThreadStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tasks-board-handlers-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    threads = new ThreadStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  function move(task: Task, body: Record<string, unknown>) {
    return moveTaskHandler(store, threads, task.id, body);
  }

  function queued(title = 't', workspaceId: string | null = null) {
    const task = store.createTask({ title, workspaceId, assignedTo: 'agent' });
    store.patchTask(task.id, { status: 'ready' });
    store.enqueueTask(task.id);
    return store.getTask(task.id)!;
  }

  function scheduledRepeat() {
    const result = createTaskHandler(store, {
      title: 'Nightly',
      triggerType: 'cron_repeat',
      triggerConfig: { expression: '0 0 * * *', timezone: 'UTC' },
    });
    if (!result.ok) throw new Error(result.error);
    return result.data!;
  }

  function scheduledOnce() {
    const result = createTaskHandler(store, {
      title: 'Once',
      triggerType: 'cron_once',
      triggerConfig: { fireAt: inAnHour(), timezone: 'UTC' },
    });
    if (!result.ok) throw new Error(result.error);
    return result.data!;
  }

  function runToCompletion(task: Task, outcome: 'done' | 'failed') {
    const entry = store.dequeueNext()!;
    expect(entry.taskId, 'the moved task is the one that runs').to.equal(task.id);
    store.completeQueueEntry(entry.id, outcome);
    return store.getTask(task.id)!;
  }

  describe('request validation', () => {
    it(`rejects an unknown lane with 400 ${TestTypes.UNIT}`, () => {
      const task = store.createTask({ title: 't' });
      expect(move(task, { to: 'nowhere' })).to.deep.include({ ok: false, status: 400 });
    });

    it(`returns 404 for an unknown task ${TestTypes.UNIT}`, () => {
      const result = moveTaskHandler(store, threads, 'missing', { to: 'queue' });
      expect(result).to.deep.include({ ok: false, status: 404 });
    });

    it(`returns 409 with the rule's reason for an illegal move, changing nothing ${TestTypes.UNIT}`, () => {
      const task = queued();
      store.dequeueNext(); // now running

      const result = move(task, { to: 'backlog' });

      expect(result).to.deep.include({ ok: false, status: 409 });
      expect(!result.ok && result.error).to.match(/only be paused/);
      expect(store.getTask(task.id)!.status).to.equal('running');
    });

    it(`returns 400 when a scheduling move is missing its start time, changing nothing ${TestTypes.UNIT}`, () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });

      const result = move(task, { to: 'scheduled' });

      expect(result).to.deep.include({ ok: false, status: 400 });
      expect(store.getTask(task.id)!.triggerType).to.equal('manual');
    });

    it(`surfaces a start time in the past as a 400 from the schedule validator ${TestTypes.UNIT}`, () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      const result = move(task, {
        to: 'scheduled',
        startAt: '2020-01-01T00:00:00.000Z',
        timezone: 'UTC',
      });
      expect(result).to.deep.include({ ok: false, status: 400 });
    });
  });

  describe('moves', () => {
    it(`Backlog → Queue enqueues the task and returns it in the queue lane ${TestTypes.UNIT}`, () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });

      const result = move(task, { to: 'queue' });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.status).to.equal('ready');
      expect(result.data.board.lane).to.equal('queue');
      expect(store.listQueue().map((e) => e.taskId)).to.deep.equal([task.id]);
    });

    it(`Backlog → Scheduled saves a one-off schedule and parks the task in Scheduled ${TestTypes.UNIT}`, () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });

      const result = move(task, { to: 'scheduled', startAt: inAnHour(), timezone: 'UTC' });

      expect(result.ok && result.data.status).to.equal('scheduled');
      expect(result.ok && result.data.triggerType).to.equal('cron_once');
      expect(result.ok && result.data.board.lane).to.equal('scheduled');
    });

    it(`Scheduled → Backlog disables the trigger so it can't fire or flip back to scheduled ${TestTypes.UNIT}`, () => {
      const task = scheduledRepeat();

      const result = move(task, { to: 'backlog' });

      expect(result.ok && result.data.status).to.equal('pending');
      expect(result.ok && result.data.board.lane).to.equal('backlog');
      expect((store.getTask(task.id)!.triggerConfig as { enabled: boolean }).enabled).to.equal(
        false,
      );
    });

    it(`Run now on a repeating schedule runs once, then returns to Scheduled ${TestTypes.UNIT}`, () => {
      const task = scheduledRepeat();

      expect(move(task, { to: 'queue' }).ok).to.equal(true);
      const after = runToCompletion(task, 'done');

      expect(after.status, 'the schedule survives a manual run').to.equal('scheduled');
    });

    it(`Run now on a one-off schedule consumes it and keeps the run's real outcome (D10) ${TestTypes.UNIT}`, () => {
      const task = scheduledOnce();

      expect(move(task, { to: 'queue' }).ok).to.equal(true);
      expect(store.getTask(task.id)!.triggerType).to.equal('manual');
      const after = runToCompletion(task, 'failed');

      expect(after.status, 'not bounced back to scheduled/pending').to.equal('failed');
    });

    it(`Queue → Backlog takes a queued task out without leaving a run in its history ${TestTypes.UNIT}`, () => {
      const task = queued();

      const result = move(task, { to: 'backlog' });

      expect(result.ok && result.data.status).to.equal('pending');
      expect(store.listTaskRuns(task.id)).to.have.length(0);
    });

    it(`Queue → Queue reorders within the workspace ${TestTypes.UNIT}`, () => {
      const ws = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      queued('a', ws.id);
      const b = queued('b', ws.id);

      expect(move(b, { to: 'queue', position: 0 }).ok).to.equal(true);

      const order = store.listQueue().map((e) => store.getTask(e.taskId)!.title);
      expect(order).to.deep.equal(['b', 'a']);
    });

    it(`Queue → Queue requires a position ${TestTypes.UNIT}`, () => {
      const task = queued();
      expect(move(task, { to: 'queue' })).to.deep.include({ ok: false, status: 400 });
    });

    it(`dropping on Done marks done, leaves the plan alone and releases dependents ${TestTypes.UNIT}`, () => {
      const plan = [
        { step: 'one', done: true },
        { step: 'two', done: false },
      ];
      const upstream = store.createTask({ title: 'upstream', assignedTo: 'agent', plan });
      const downstream = store.createTask({ title: 'downstream', assignedTo: 'agent' });
      store.addTaskDependency(downstream.id, upstream.id, { requireSuccess: true });

      const result = move(upstream, { to: 'done' });

      expect(result.ok && result.data.status).to.equal('done');
      expect(store.getTask(upstream.id)!.plan, 'D6: no step is claimed done').to.deep.equal(plan);
      expect(
        store.getTask(downstream.id)!.status,
        'a manual Done unblocks dependents like a finished run does',
      ).to.equal('ready');
    });

    it(`Running → Needs attention pauses the live run ${TestTypes.UNIT}`, () => {
      const task = queued();
      const entry = store.dequeueNext()!;
      const controller = registerTaskAbort(entry.id);
      try {
        const result = move(task, { to: 'attention' });

        expect(result.ok).to.equal(true);
        expect(controller.signal.aborted).to.equal(true);
        expect(getTaskAbort(entry.id)?.intent).to.equal('pause');
      } finally {
        clearTaskAbort(entry.id);
      }
    });

    it(`Needs attention (paused) → Backlog closes out the paused run and returns to pending ${TestTypes.UNIT}`, () => {
      const task = queued();
      const entry = store.dequeueNext()!;
      store.parkQueueEntry(entry.id);

      const result = move(task, { to: 'backlog' });

      expect(result.ok && result.data.status).to.equal('pending');
      expect(store.listQueue(), 'no wedged paused row is left behind').to.have.length(0);
    });

    it(`Needs attention (paused) → Queue resumes the paused run ${TestTypes.UNIT}`, () => {
      const task = queued();
      const entry = store.dequeueNext()!;
      store.parkQueueEntry(entry.id);

      const result = move(task, { to: 'queue' });

      expect(result.ok && result.data.status).to.equal('ready');
      expect(store.getQueueEntry(entry.id)!.status, 'the same run resumes').to.equal('pending');
    });

    it(`Needs attention (failed) → Queue retries ${TestTypes.UNIT}`, () => {
      const task = queued();
      runToCompletion(task, 'failed');

      const result = move(task, { to: 'queue' });

      expect(result.ok && result.data.status).to.equal('ready');
    });

    it(`a user-assigned task needs an explicit hand-off before it can be queued (D3) ${TestTypes.UNIT}`, () => {
      const task = store.createTask({ title: 't', assignedTo: 'user' });

      expect(move(task, { to: 'queue' })).to.deep.include({ ok: false, status: 400 });
      const result = move(task, { to: 'queue', assignTo: 'agent' });

      expect(result.ok && result.data.assignedTo).to.equal('agent');
      expect(result.ok && result.data.status).to.equal('ready');
    });

    describe('answering the agent', () => {
      function waitingTask() {
        const task = queued();
        const entry = store.listQueue()[0]!;
        store.setQueueEntryThread(entry.id, 'run-thread');
        store.dequeueNext();
        store.parkQueueEntryForHitl(entry.id);
        threads.upsertThreadOnFirstMessage('run-thread', 'run');
        recordHitlPrompt(threads, 'run-thread', 'prompt-1', {
          question: 'NAS or MinIO?',
          promptKind: 'multiple_choice',
          choices: ['NAS', 'MinIO'],
          taskId: task.id,
        });
        return store.getTask(task.id)!;
      }

      it(`Waiting → Queue with a reply answers the question and resumes the task ${TestTypes.UNIT}`, () => {
        const task = waitingTask();

        const result = move(task, { to: 'queue', reply: 'NAS' });

        expect(result.ok && result.data.status).to.equal('ready');
        expect(store.getTask(task.id)!.resumeAnswer).to.equal('NAS');
        expect(threads.getMessage('run-thread', 'prompt-1')!.status).to.equal('answered');
      });

      it(`Waiting → Queue without a reply is a 400 and leaves the question open ${TestTypes.UNIT}`, () => {
        const task = waitingTask();

        expect(move(task, { to: 'queue', reply: '  ' })).to.deep.include({
          ok: false,
          status: 400,
        });
        expect(threads.getMessage('run-thread', 'prompt-1')!.status).to.equal('pending');
      });

      it(`shows the question and its choices on the waiting card ${TestTypes.UNIT}`, () => {
        const task = waitingTask();

        const [response] = withBoards(store, threads, [task]);

        expect(response!.board.reason).to.deep.equal({
          kind: 'waiting_on_user',
          question: 'NAS or MinIO?',
          choices: [
            { label: 'NAS', value: 'NAS' },
            { label: 'MinIO', value: 'MinIO' },
          ],
          allowFreeText: false,
        });
      });

      it(`maps a shell approval to its fixed answers rather than free text ${TestTypes.UNIT}`, () => {
        const task = queued();
        const entry = store.listQueue()[0]!;
        store.setQueueEntryThread(entry.id, 'shell-thread');
        store.dequeueNext();
        store.parkQueueEntryForHitl(entry.id);
        threads.upsertThreadOnFirstMessage('shell-thread', 'run');
        recordHitlPrompt(threads, 'shell-thread', 'p', {
          question: 'Run rm -rf build?',
          promptKind: 'shell_approval',
          taskId: task.id,
        });

        const [response] = withBoards(store, threads, [store.getTask(task.id)!]);

        expect(response!.board.reason).to.deep.include({
          choices: [
            { label: 'Deny', value: 'denied' },
            { label: 'Approve & remember', value: 'approved_remember' },
            { label: 'Approve', value: 'approved' },
          ],
          allowFreeText: false,
        });
      });
    });

    it(`Needs attention (paused schedule) → Scheduled turns the schedule back on ${TestTypes.UNIT}`, () => {
      const task = scheduledRepeat();
      store.patchTask(task.id, {
        status: 'pending',
        triggerConfig: {
          ...(task.triggerConfig as object),
          enabled: false,
          pausedReason: 'consecutive_failures',
          consecutiveFailures: 3,
        },
      });
      const paused = store.getTask(task.id)!;
      expect(withBoards(store, threads, [paused])[0]!.board.lane).to.equal('attention');

      const result = move(paused, { to: 'scheduled' });

      expect(result.ok && result.data.status).to.equal('scheduled');
      expect(result.ok && result.data.board.lane).to.equal('scheduled');
    });
  });

  describe('board projection', () => {
    it(`attaches a board to every listed task ${TestTypes.UNIT}`, () => {
      store.createTask({ title: 'a', assignedTo: 'agent' });
      queued('b');

      const boards = withBoards(store, threads, store.listTasks()).map((t) => t.board.lane);

      expect(boards.sort()).to.deep.equal(['backlog', 'queue']);
    });

    it(`builds contexts with one query per fact type however many tasks there are ${TestTypes.UNIT}`, () => {
      for (let i = 0; i < 5; i++) queued(`t${i}`);
      const calls: Record<string, number> = {};
      const count = <K extends keyof WorkspaceStore>(name: K) => {
        const original = (store[name] as (...args: unknown[]) => unknown).bind(store);
        (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
          calls[name] = (calls[name] ?? 0) + 1;
          return original(...args);
        };
      };
      count('listQueue');
      count('listDependencyEdgesForTasks');
      count('failedRunStreaks');

      buildBoardContexts(store, threads, store.listTasks());

      expect(calls).to.deep.equal({
        listQueue: 1,
        listDependencyEdgesForTasks: 1,
        failedRunStreaks: 1,
      });
    });
  });
});
