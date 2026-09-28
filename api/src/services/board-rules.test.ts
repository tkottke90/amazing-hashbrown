import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  boardFor,
  planMove,
  type BoardContext,
  type Lane,
  type MovePlan,
  type MoveStep,
} from './board-rules.js';
import type { TaskSchedule } from './cron-config.js';
import type { DependencyEdgeSummary, Task, TaskQueueEntry } from './workspace-store.js';

enum TestTypes {
  UNIT = '[unit]',
}

// The move table and lane rules are the whole contract between the board UI
// and the task lifecycle, so every cell is pinned here: a change to a rule
// must show up as a deliberate test change.

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    workspaceId: 'w1',
    title: 'Task',
    description: null,
    outcome: null,
    status: 'pending',
    assignedTo: 'agent',
    dueAt: null,
    expiresAt: null,
    triggerType: 'manual',
    triggerConfig: null,
    trackerType: null,
    trackerId: null,
    plan: null,
    threadId: null,
    resumeAnswer: null,
    origin: 'user',
    parentThreadId: null,
    dispatchGroupId: null,
    role: null,
    blockedReason: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function queueEntry(status: TaskQueueEntry['status']): TaskQueueEntry {
  return {
    id: 'q1',
    taskId: 't1',
    status,
    position: 1,
    enqueuedAt: '2026-09-28T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    recoveryAttempts: 0,
    pauseReason: status === 'paused' ? 'user' : null,
    pausedAt: null,
    threadId: 'run-1',
    summary: null,
    triggerSource: 'manual',
    scheduledFor: null,
  };
}

function schedule(overrides: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    nextFireAt: '2026-10-01T02:00:00.000Z',
    iterationCount: 0,
    active: true,
    inactiveReason: null,
    ...overrides,
  };
}

function edge(
  targetStatus: Task['status'],
  satisfied: boolean,
  requireSuccess = true,
): DependencyEdgeSummary {
  return {
    dependency: {
      id: 1,
      taskId: 't1',
      dependsOnTaskId: 'dep',
      requireSuccess,
      whileBlocked: false,
      createdAt: '2026-09-28T00:00:00.000Z',
    },
    target: { id: 'dep', title: 'Deploy', trackerId: 'INF-12', status: targetStatus },
    satisfied,
  };
}

function ctx(overrides: Partial<BoardContext> = {}): BoardContext {
  return {
    queueEntry: null,
    dependencies: [],
    schedule: null,
    pendingPrompt: null,
    failedStreak: null,
    ...overrides,
  };
}

const PROMPT = {
  threadId: 'run-1',
  promptId: 'p1',
  question: 'NAS or MinIO?',
  choices: [
    { label: 'NAS', value: 'NAS' },
    { label: 'MinIO', value: 'MinIO' },
  ],
  allowFreeText: true,
};

// A named source row of the move table: a task + context that sourceOf()
// classifies as that row.
const SOURCES = {
  pendingAgent: () => ({ t: task(), c: ctx() }),
  pendingUser: () => ({ t: task({ assignedTo: 'user' }), c: ctx() }),
  pendingWaitingDependency: () => ({
    t: task(),
    c: ctx({ dependencies: [edge('running', false)] }),
  }),
  scheduledOnce: () => ({
    t: task({ status: 'scheduled', triggerType: 'cron_once' }),
    c: ctx({ schedule: schedule() }),
  }),
  scheduledRepeat: () => ({
    t: task({ status: 'scheduled', triggerType: 'cron_repeat' }),
    c: ctx({ schedule: schedule() }),
  }),
  readyQueued: () => ({
    t: task({ status: 'ready' }),
    c: ctx({ queueEntry: queueEntry('pending') }),
  }),
  running: () => ({
    t: task({ status: 'running' }),
    c: ctx({ queueEntry: queueEntry('running') }),
  }),
  waiting: () => ({
    t: task({ status: 'waiting_on_user', assignedTo: 'user' }),
    c: ctx({ queueEntry: queueEntry('paused'), pendingPrompt: PROMPT }),
  }),
  blockedPaused: () => ({
    t: task({ status: 'blocked' }),
    c: ctx({ queueEntry: queueEntry('paused') }),
  }),
  blockedDependencyFailed: () => ({
    t: task({ status: 'blocked', blockedReason: 'dependency_failed' }),
    c: ctx({ dependencies: [edge('failed', false)] }),
  }),
  failed: () => ({
    t: task({ status: 'failed' }),
    c: ctx({ failedStreak: { attempts: 2, lastSummary: 'step-ca unreachable' } }),
  }),
  schedulePaused: () => ({
    t: task({
      triggerType: 'cron_repeat',
      triggerConfig: { enabled: false, consecutiveFailures: 3 },
    }),
    c: ctx({ schedule: schedule({ active: false, inactiveReason: 'failures', nextFireAt: null }) }),
  }),
  done: () => ({ t: task({ status: 'done' }), c: ctx() }),
  cancelled: () => ({ t: task({ status: 'cancelled' }), c: ctx() }),
  doneRepeat: () => ({
    t: task({ status: 'done', triggerType: 'cron_repeat' }),
    c: ctx({
      schedule: schedule({ active: false, inactiveReason: 'exhausted', nextFireAt: null }),
    }),
  }),
};

type SourceName = keyof typeof SOURCES;

function move(source: SourceName, to: Lane): MovePlan {
  const { t, c } = SOURCES[source]();
  return planMove(t, c, to);
}

function steps(result: MovePlan): MoveStep[] {
  if (!result.ok) throw new Error(`expected an allowed move, got rejection: ${result.reason}`);
  return result.steps;
}

function expectAllowed(
  source: SourceName,
  to: Lane,
  expected: MoveStep[],
  needs: 'none' | 'start_time' | 'reply' | 'reassign' = 'none',
) {
  const result = move(source, to);
  expect(steps(result), `${source} → ${to} steps`).to.deep.equal(expected);
  expect(result.ok && result.needs, `${source} → ${to} needs`).to.equal(needs);
}

function expectRejected(source: SourceName, to: Lane, reasonPattern: RegExp) {
  const result = move(source, to);
  expect(result.ok, `${source} → ${to} must be rejected`).to.equal(false);
  if (!result.ok) expect(result.reason).to.match(reasonPattern);
}

const DONE: MoveStep[] = [{ kind: 'patch_status', status: 'done' }, { kind: 'release_dependents' }];

describe('services/board-rules', () => {
  describe('lane assignment (spec §1.2)', () => {
    const cases: Array<[SourceName, Lane, string | undefined]> = [
      ['waiting', 'attention', 'waiting_on_user'],
      ['failed', 'attention', 'failed'],
      ['blockedDependencyFailed', 'attention', 'dependency_failed'],
      ['blockedPaused', 'attention', 'paused'],
      ['schedulePaused', 'attention', 'schedule_paused'],
      ['readyQueued', 'queue', undefined],
      ['running', 'queue', undefined],
      ['scheduledRepeat', 'scheduled', undefined],
      ['done', 'done', undefined],
      ['cancelled', 'done', undefined],
      ['pendingUser', 'backlog', 'assigned_to_user'],
      ['pendingWaitingDependency', 'backlog', 'waiting_on_dependency'],
      ['pendingAgent', 'backlog', undefined],
    ];

    for (const [source, lane, reason] of cases) {
      it(`puts a ${source} task in ${lane}${reason ? ` with reason ${reason}` : ''} ${TestTypes.UNIT}`, () => {
        const { t, c } = SOURCES[source]();
        const board = boardFor(t, c);
        expect(board.lane).to.equal(lane);
        expect(board.reason?.kind).to.equal(reason);
      });
    }

    it(`puts a pending cron task whose schedule is exhausted, expired or fired in done ${TestTypes.UNIT}`, () => {
      for (const inactiveReason of ['exhausted', 'expired', 'fired'] as const) {
        const board = boardFor(
          task({ triggerType: 'cron_repeat' }),
          ctx({ schedule: schedule({ active: false, inactiveReason, nextFireAt: null }) }),
        );
        expect(board.lane, `inactiveReason ${inactiveReason}`).to.equal('done');
      }
    });

    it(`keeps a disabled (not failed) schedule in backlog — nobody needs to act ${TestTypes.UNIT}`, () => {
      const board = boardFor(
        task({ triggerType: 'cron_repeat' }),
        ctx({
          schedule: schedule({ active: false, inactiveReason: 'disabled', nextFireAt: null }),
        }),
      );
      expect(board.lane).to.equal('backlog');
    });

    it(`does not treat a dependency on a running task as needing attention (D2) ${TestTypes.UNIT}`, () => {
      const { t, c } = SOURCES.pendingWaitingDependency();
      expect(boardFor(t, c).reason).to.deep.equal({
        kind: 'waiting_on_dependency',
        dependencies: [{ id: 'dep', title: 'Deploy', trackerId: 'INF-12' }],
      });
    });

    it(`lists only unmet dependencies on the waiting badge ${TestTypes.UNIT}`, () => {
      const board = boardFor(
        task(),
        ctx({ dependencies: [edge('done', true), edge('running', false)] }),
      );
      expect(
        board.reason?.kind === 'waiting_on_dependency' && board.reason.dependencies,
      ).to.have.length(1);
    });

    it(`shows a user-assigned task as the user's even when it also waits on a dependency (D3) ${TestTypes.UNIT}`, () => {
      const board = boardFor(
        task({ assignedTo: 'user' }),
        ctx({ dependencies: [edge('running', false)] }),
      );
      expect(board.reason?.kind).to.equal('assigned_to_user');
    });

    it(`carries the agent's question and choices on a waiting card ${TestTypes.UNIT}`, () => {
      const { t, c } = SOURCES.waiting();
      expect(boardFor(t, c).reason).to.deep.equal({
        kind: 'waiting_on_user',
        question: 'NAS or MinIO?',
        choices: PROMPT.choices,
        allowFreeText: true,
      });
    });

    it(`falls back to a free-text reply when a waiting task's prompt can't be found ${TestTypes.UNIT}`, () => {
      const board = boardFor(task({ status: 'waiting_on_user' }), ctx());
      expect(board.reason).to.deep.equal({
        kind: 'waiting_on_user',
        question: null,
        choices: [],
        allowFreeText: true,
      });
    });

    it(`carries the failure summary and consecutive attempt count on a failed card ${TestTypes.UNIT}`, () => {
      const { t, c } = SOURCES.failed();
      expect(boardFor(t, c).reason).to.deep.equal({
        kind: 'failed',
        summary: 'step-ca unreachable',
        attempts: 2,
      });
    });

    it(`names the failed dependency on a dependency_failed card ${TestTypes.UNIT}`, () => {
      const { t, c } = SOURCES.blockedDependencyFailed();
      expect(boardFor(t, c).reason).to.deep.equal({
        kind: 'dependency_failed',
        dependency: { id: 'dep', title: 'Deploy', trackerId: 'INF-12' },
      });
    });

    it(`reports the schedule's consecutive failures on a paused schedule ${TestTypes.UNIT}`, () => {
      const { t, c } = SOURCES.schedulePaused();
      expect(boardFor(t, c).reason).to.deep.equal({ kind: 'schedule_paused', failures: 3 });
    });
  });

  describe('move table (spec §1.3)', () => {
    describe('from Backlog (pending, agent)', () => {
      it(`schedules via the start-time picker ${TestTypes.UNIT}`, () =>
        expectAllowed('pendingAgent', 'scheduled', [{ kind: 'save_cron_once' }], 'start_time'));
      it(`enqueues on Queue ${TestTypes.UNIT}`, () =>
        expectAllowed('pendingAgent', 'queue', [{ kind: 'enqueue' }]));
      it(`marks done and releases dependents on Done ${TestTypes.UNIT}`, () =>
        expectAllowed('pendingAgent', 'done', DONE));
      it(`rejects Needs attention ${TestTypes.UNIT}`, () =>
        expectRejected('pendingAgent', 'attention', /on their own/));
      it(`rejects its own lane ${TestTypes.UNIT}`, () =>
        expectRejected('pendingAgent', 'backlog', /Already/));
    });

    describe('from Backlog (pending, assigned to the user)', () => {
      it(`asks to hand the task to the agent before enqueueing (D3) ${TestTypes.UNIT}`, () =>
        expectAllowed(
          'pendingUser',
          'queue',
          [{ kind: 'reassign_to_agent' }, { kind: 'enqueue' }],
          'reassign',
        ));
      it(`schedules via the picker ${TestTypes.UNIT}`, () =>
        expectAllowed('pendingUser', 'scheduled', [{ kind: 'save_cron_once' }], 'start_time'));
      it(`marks done on Done ${TestTypes.UNIT}`, () => expectAllowed('pendingUser', 'done', DONE));
      it(`rejects Needs attention ${TestTypes.UNIT}`, () =>
        expectRejected('pendingUser', 'attention', /on their own/));
    });

    describe('from Backlog (waiting on a dependency)', () => {
      it(`rejects Queue so the dependency gate can't be skipped ${TestTypes.UNIT}`, () =>
        expectRejected('pendingWaitingDependency', 'queue', /waiting on its dependencies/));
      it(`rejects Scheduled so a timed fire can't skip the dependency gate ${TestTypes.UNIT}`, () =>
        expectRejected('pendingWaitingDependency', 'scheduled', /waiting on its dependencies/));
      it(`still allows marking done by hand ${TestTypes.UNIT}`, () =>
        expectAllowed('pendingWaitingDependency', 'done', DONE));
      it(`rejects Needs attention ${TestTypes.UNIT}`, () =>
        expectRejected('pendingWaitingDependency', 'attention', /on their own/));
    });

    describe('from Scheduled', () => {
      it(`disables the trigger on Backlog so the schedule can't fire (or flip it back) ${TestTypes.UNIT}`, () =>
        expectAllowed('scheduledRepeat', 'backlog', [{ kind: 'disable_trigger' }]));
      it(`Run now on a repeating schedule just enqueues — it returns to Scheduled after the run ${TestTypes.UNIT}`, () =>
        expectAllowed('scheduledRepeat', 'queue', [{ kind: 'enqueue' }]));
      it(`Run now on a one-off schedule consumes it (D10) ${TestTypes.UNIT}`, () =>
        expectAllowed('scheduledOnce', 'queue', [{ kind: 'clear_trigger' }, { kind: 'enqueue' }]));
      it(`reschedules a one-off via the picker ${TestTypes.UNIT}`, () =>
        expectAllowed('scheduledOnce', 'scheduled', [{ kind: 'save_cron_once' }], 'start_time'));
      it(`rejects rescheduling a repeating schedule by drag ${TestTypes.UNIT}`, () =>
        expectRejected('scheduledRepeat', 'scheduled', /repeating schedule/));
      it(`disables the trigger then marks done on Done ${TestTypes.UNIT}`, () =>
        expectAllowed('scheduledRepeat', 'done', [{ kind: 'disable_trigger' }, ...DONE]));
      it(`rejects Needs attention ${TestTypes.UNIT}`, () =>
        expectRejected('scheduledRepeat', 'attention', /on their own/));
    });

    describe('from Queue (ready)', () => {
      it(`dequeues on Backlog ${TestTypes.UNIT}`, () =>
        expectAllowed('readyQueued', 'backlog', [{ kind: 'dequeue' }]));
      it(`dequeues then schedules on Scheduled ${TestTypes.UNIT}`, () =>
        expectAllowed(
          'readyQueued',
          'scheduled',
          [{ kind: 'dequeue' }, { kind: 'save_cron_once' }],
          'start_time',
        ));
      it(`reorders within Queue ${TestTypes.UNIT}`, () =>
        expectAllowed('readyQueued', 'queue', [{ kind: 'reorder' }]));
      it(`dequeues then marks done on Done, never touching the plan (D6) ${TestTypes.UNIT}`, () =>
        expectAllowed('readyQueued', 'done', [{ kind: 'dequeue' }, ...DONE]));
      it(`rejects Needs attention — only running tasks can be paused ${TestTypes.UNIT}`, () =>
        expectRejected('readyQueued', 'attention', /only a running task/));
      it(`falls back to a status patch when a ready task has no pending queue row ${TestTypes.UNIT}`, () => {
        const result = planMove(task({ status: 'ready', assignedTo: 'user' }), ctx(), 'backlog');
        expect(steps(result)).to.deep.equal([{ kind: 'patch_status', status: 'pending' }]);
      });
      it(`rejects reordering a ready task with no pending queue row ${TestTypes.UNIT}`, () => {
        const result = planMove(task({ status: 'ready' }), ctx(), 'queue');
        expect(result.ok).to.equal(false);
      });
    });

    describe('from Queue (running)', () => {
      it(`pauses on Needs attention ${TestTypes.UNIT}`, () =>
        expectAllowed('running', 'attention', [{ kind: 'pause' }]));
      for (const to of ['backlog', 'scheduled', 'done'] as const) {
        it(`rejects ${to} — a running task is cancelled from the task details, never by drag ${TestTypes.UNIT}`, () =>
          expectRejected('running', to, /only be paused/));
      }
    });

    describe('from Needs attention (waiting on you)', () => {
      it(`answers the pending prompt on Queue, after collecting a reply ${TestTypes.UNIT}`, () =>
        expectAllowed(
          'waiting',
          'queue',
          [{ kind: 'answer_prompt', threadId: 'run-1', promptId: 'p1' }],
          'reply',
        ));
      it(`rejects Queue when the prompt can't be found ${TestTypes.UNIT}`, () => {
        const result = planMove(task({ status: 'waiting_on_user' }), ctx(), 'queue');
        expect(result.ok).to.equal(false);
      });
      for (const to of ['backlog', 'scheduled', 'done'] as const) {
        it(`rejects ${to} until the question is answered ${TestTypes.UNIT}`, () =>
          expectRejected('waiting', to, /question first/));
      }
    });

    describe('from Needs attention (paused by a person)', () => {
      it(`resumes on Queue ${TestTypes.UNIT}`, () =>
        expectAllowed('blockedPaused', 'queue', [{ kind: 'resume' }]));
      it(`closes out the paused run then returns to pending on Backlog ${TestTypes.UNIT}`, () =>
        expectAllowed('blockedPaused', 'backlog', [
          { kind: 'detach_paused' },
          { kind: 'patch_status', status: 'pending' },
        ]));
      it(`closes out the paused run before scheduling ${TestTypes.UNIT}`, () =>
        expectAllowed(
          'blockedPaused',
          'scheduled',
          [
            { kind: 'detach_paused' },
            { kind: 'patch_status', status: 'pending' },
            { kind: 'save_cron_once' },
          ],
          'start_time',
        ));
      it(`closes out the paused run then marks done ${TestTypes.UNIT}`, () =>
        expectAllowed('blockedPaused', 'done', [{ kind: 'detach_paused' }, ...DONE]));
    });

    describe('from Needs attention (dependency failed)', () => {
      it(`returns to pending on Backlog ${TestTypes.UNIT}`, () =>
        expectAllowed('blockedDependencyFailed', 'backlog', [
          { kind: 'patch_status', status: 'pending' },
        ]));
      it(`marks done on Done ${TestTypes.UNIT}`, () =>
        expectAllowed('blockedDependencyFailed', 'done', DONE));
      for (const to of ['queue', 'scheduled'] as const) {
        it(`rejects ${to} — the broken dependency must be dealt with first ${TestTypes.UNIT}`, () =>
          expectRejected('blockedDependencyFailed', to, /dependency of this task failed/));
      }
    });

    describe('from Needs attention (failed)', () => {
      it(`returns to pending on Backlog ${TestTypes.UNIT}`, () =>
        expectAllowed('failed', 'backlog', [{ kind: 'patch_status', status: 'pending' }]));
      it(`schedules a retry via the picker ${TestTypes.UNIT}`, () =>
        expectAllowed('failed', 'scheduled', [{ kind: 'save_cron_once' }], 'start_time'));
      it(`retries on Queue ${TestTypes.UNIT}`, () =>
        expectAllowed('failed', 'queue', [{ kind: 'enqueue' }]));
      it(`marks done on Done ${TestTypes.UNIT}`, () => expectAllowed('failed', 'done', DONE));
    });

    describe('from Needs attention (schedule paused after failures)', () => {
      it(`resumes the schedule on Scheduled ${TestTypes.UNIT}`, () =>
        expectAllowed('schedulePaused', 'scheduled', [{ kind: 'enable_trigger' }]));
      it(`runs it once by hand on Queue ${TestTypes.UNIT}`, () =>
        expectAllowed('schedulePaused', 'queue', [{ kind: 'enqueue' }]));
      it(`drops the schedule on Backlog ${TestTypes.UNIT}`, () =>
        expectAllowed('schedulePaused', 'backlog', [{ kind: 'clear_trigger' }]));
      it(`marks done on Done ${TestTypes.UNIT}`, () =>
        expectAllowed('schedulePaused', 'done', DONE));
    });

    describe('from Done', () => {
      it(`reopens to pending on Backlog ${TestTypes.UNIT}`, () =>
        expectAllowed('done', 'backlog', [{ kind: 'patch_status', status: 'pending' }]));
      it(`reopens a cancelled task too ${TestTypes.UNIT}`, () =>
        expectAllowed('cancelled', 'backlog', [{ kind: 'patch_status', status: 'pending' }]));
      it(`drops a finished schedule when reopening, or it would land back in Done ${TestTypes.UNIT}`, () =>
        expectAllowed('doneRepeat', 'backlog', [
          { kind: 'clear_trigger' },
          { kind: 'patch_status', status: 'pending' },
        ]));
      it(`reruns on Queue ${TestTypes.UNIT}`, () =>
        expectAllowed('done', 'queue', [{ kind: 'enqueue' }]));
      it(`schedules a rerun via the picker ${TestTypes.UNIT}`, () =>
        expectAllowed('done', 'scheduled', [{ kind: 'save_cron_once' }], 'start_time'));
      it(`rejects scheduling a finished repeating task by drag ${TestTypes.UNIT}`, () =>
        expectRejected('doneRepeat', 'scheduled', /repeating schedule/));
      it(`rejects Needs attention ${TestTypes.UNIT}`, () =>
        expectRejected('done', 'attention', /on their own/));
    });

    describe('trigger protection', () => {
      it(`never lets a drag overwrite a webhook trigger with a one-off time ${TestTypes.UNIT}`, () => {
        const result = planMove(task({ triggerType: 'webhook' }), ctx(), 'scheduled');
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.reason).to.match(/Webhook/);
      });
    });
  });

  describe('boardFor().moves', () => {
    it(`lists exactly the lanes planMove allows, with their needs ${TestTypes.UNIT}`, () => {
      for (const source of Object.keys(SOURCES) as SourceName[]) {
        const { t, c } = SOURCES[source]();
        const expected = (['backlog', 'scheduled', 'queue', 'attention', 'done'] as Lane[])
          .map((to) => ({ to, result: planMove(t, c, to) }))
          .filter(({ result }) => result.ok)
          .map(({ to, result }) => ({ to, needs: result.ok ? result.needs : 'none' }));
        expect(boardFor(t, c).moves, source).to.deep.equal(expected);
      }
    });

    it(`gives a running task exactly one move: pause into Needs attention ${TestTypes.UNIT}`, () => {
      const { t, c } = SOURCES.running();
      expect(boardFor(t, c).moves).to.deep.equal([{ to: 'attention', needs: 'none' }]);
    });
  });
});
