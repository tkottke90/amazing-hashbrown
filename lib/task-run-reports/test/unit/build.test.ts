import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import type {
  ThreadReportMessageRecord,
  ThreadReportThreadDetail,
} from '@tkottke90/thread-reports';
import { buildTaskRunReport } from '../../src/build.js';
import type {
  WorkspaceLike,
  TaskLike,
  TaskRunLike,
  FailedRunStreakLike,
  HandedOffRunSummaryLike,
  TaskProgressEntryLike,
  TaskRunReportStoreLike,
} from '../../src/types.js';

enum TestTypes {
  UNIT = '[unit]',
}

function makeMessage(overrides: {
  id: string;
  threadId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}): ThreadReportMessageRecord {
  return {
    id: overrides.id,
    threadId: overrides.threadId,
    seq: overrides.seq,
    kind: overrides.kind,
    status: null,
    retryOf: null,
    checkpointId: null,
    payload: overrides.payload,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  };
}

function makeThread(
  id: string,
  messages: ThreadReportMessageRecord[] = [],
): ThreadReportThreadDetail {
  return {
    id,
    title: `Thread ${id}`,
    createdAt: '2026-11-18T09:00:00.000Z',
    updatedAt: '2026-11-18T09:00:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    messages,
  };
}

interface FakeWorkspaceStoreFixtures {
  task: TaskLike | null;
  workspace?: WorkspaceLike | null;
  runs?: TaskRunLike[];
  failedStreaks?: Map<string, FailedRunStreakLike>;
  handoffCounts?: Map<string, HandedOffRunSummaryLike>;
  progressEntries?: TaskProgressEntryLike[];
}

function fakeWorkspaceStore(fixtures: FakeWorkspaceStoreFixtures): TaskRunReportStoreLike {
  return {
    getTask: () => fixtures.task,
    getWorkspace: () => fixtures.workspace ?? null,
    listTaskRuns: () => fixtures.runs ?? [],
    failedRunStreaks: () => fixtures.failedStreaks ?? new Map(),
    handedOffRunCounts: () => fixtures.handoffCounts ?? new Map(),
    listTaskProgressEntriesForTask: () => fixtures.progressEntries ?? [],
  };
}

function makeTask(overrides: Partial<TaskLike> = {}): TaskLike {
  return {
    id: 'task-1',
    title: 'Build labeler automation',
    status: 'running',
    origin: 'agent',
    provider: 'ollama',
    model: 'qwen3:14b',
    workspaceId: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<TaskRunLike> = {}): TaskRunLike {
  return {
    id: 'run-1',
    runNumber: 1,
    status: 'done',
    summary: null,
    recoveryAttempts: 0,
    threadId: null,
    ...overrides,
  };
}

describe('build/buildTaskRunReport', () => {
  let observabilityStore: ObservabilityStore;
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-run-reports-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    observabilityStore = new ObservabilityStore(db);
  });

  after(() => {
    rmSync(dir, { recursive: true });
  });

  it(`returns null when the task does not exist ${TestTypes.UNIT}`, () => {
    const result = buildTaskRunReport('missing', {
      workspaceStore: fakeWorkspaceStore({ task: null }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });
    expect(result).to.equal(null);
  });

  it(`builds a report with no runs yet, and no anomalies ${TestTypes.UNIT}`, () => {
    const task = makeTask({ status: 'pending' });
    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({ task, runs: [] }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });
    expect(result).to.not.equal(null);
    expect(result?.runs).to.deep.equal([]);
    expect(result?.anomalies).to.deep.equal([]);
    expect(result?.handoff).to.equal(null);
    expect(result?.summary).to.deep.equal({
      runCount: 0,
      failureCount: 0,
      wikiWriteCount: 0,
      anomalyCount: 0,
    });
  });

  it(`sets runsToComplete to the run count once the task reaches 'done' ${TestTypes.UNIT}`, () => {
    const task = makeTask({ status: 'done' });
    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        runs: [makeRun({ id: 'run-1', runNumber: 1 }), makeRun({ id: 'run-2', runNumber: 2 })],
      }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });
    expect(result?.runsToComplete).to.equal(2);
  });

  it(`leaves runsToComplete null while the task hasn't reached 'done' ${TestTypes.UNIT}`, () => {
    const task = makeTask({ status: 'running' });
    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({ task, runs: [makeRun()] }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });
    expect(result?.runsToComplete).to.equal(null);
  });

  it(`flags a wiki_update whose wikiName does not match the task's workspace wikiId ${TestTypes.UNIT}`, () => {
    const task = makeTask({ workspaceId: 'ws-1' });
    const workspace: WorkspaceLike = { id: 'ws-1', wikiId: 'personal' };
    const runThread = makeThread('run-thread-1', [
      makeMessage({
        id: 'w1',
        threadId: 'run-thread-1',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Minecraft', pageKind: 'entity', wikiName: 'work' },
        createdAt: '2026-11-18T10:00:00.000Z',
      }),
    ]);

    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        workspace,
        runs: [makeRun({ threadId: 'run-thread-1' })],
      }),
      threadStore: { getThread: (id: string) => (id === 'run-thread-1' ? runThread : null) },
      observabilityStore,
    });

    expect(result?.anomalies).to.have.length(1);
    expect(result?.anomalies[0]).to.deep.include({
      kind: 'wiki_mismatch',
      actualWikiName: 'work',
      expectedWikiId: 'personal',
    });
  });

  it(`never checks wiki_mismatch for a workspace-less task ${TestTypes.UNIT}`, () => {
    const task = makeTask({ workspaceId: null });
    const runThread = makeThread('run-thread-1', [
      makeMessage({
        id: 'w1',
        threadId: 'run-thread-1',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Minecraft', pageKind: 'entity', wikiName: 'anything' },
        createdAt: '2026-11-18T10:00:00.000Z',
      }),
    ]);

    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        runs: [makeRun({ threadId: 'run-thread-1' })],
      }),
      threadStore: { getThread: (id: string) => (id === 'run-thread-1' ? runThread : null) },
      observabilityStore,
    });

    expect(result?.anomalies).to.have.length(0);
  });

  it(`flags a recursion-guard escalation inside a run thread, tagged with the taskId ${TestTypes.UNIT}`, () => {
    const task = makeTask();
    const runThread = makeThread('run-thread-1', [
      makeMessage({
        id: 'h1',
        threadId: 'run-thread-1',
        seq: 1,
        kind: 'hitl_prompt',
        payload: {
          promptId: 'p1',
          question: 'Reached 75 LLM calls without a check-in opportunity.',
          kind: 'recursion_limit_warning',
          choices: ['Continue working', 'Stop and summarize what you have done so far'],
        },
        createdAt: '2026-11-18T10:05:00.000Z',
      }),
    ]);

    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        runs: [makeRun({ threadId: 'run-thread-1' })],
      }),
      threadStore: { getThread: (id: string) => (id === 'run-thread-1' ? runThread : null) },
      observabilityStore,
    });

    expect(result?.anomalies).to.have.length(1);
    expect(result?.anomalies[0]).to.deep.include({
      kind: 'recursion_escalation',
      taskId: 'task-1',
      escalationKind: 'recursion_limit_warning',
    });
  });

  it(`flags a task that failed repeated times before its last settled run, via failedRunStreaks ${TestTypes.UNIT}`, () => {
    const task = makeTask({ title: 'Flaky task' });

    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        runs: [],
        failedStreaks: new Map([
          ['task-1', { attempts: 2, lastSummary: 'Hit tool error twice in a row' }],
        ]),
      }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });

    expect(result?.anomalies).to.have.length(1);
    expect(result?.anomalies[0]).to.deep.equal({
      kind: 'repeated_failures',
      taskId: 'task-1',
      taskTitle: 'Flaky task',
      attempts: 2,
      lastSummary: 'Hit tool error twice in a row',
    });
  });

  it(`surfaces handed_off runs as its own handoff signal, not an anomaly ${TestTypes.UNIT}`, () => {
    const task = makeTask({ title: 'Migrate config' });

    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        runs: [],
        handoffCounts: new Map([
          ['task-1', { count: 2, lastSummary: 'Stopped at the user’s request.' }],
        ]),
      }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });

    expect(
      result?.anomalies,
      'a handoff is not a failure and must not be flagged as one',
    ).to.have.length(0);
    expect(result?.handoff).to.deep.equal({
      taskId: 'task-1',
      taskTitle: 'Migrate config',
      count: 2,
      lastSummary: 'Stopped at the user’s request.',
    });
  });

  it(`attaches the task's own progress entries, and aggregates wiki-write/failure totals across runs ${TestTypes.UNIT}`, () => {
    const task = makeTask({ workspaceId: 'ws-1' });
    const workspace: WorkspaceLike = { id: 'ws-1', wikiId: 'personal' };
    const runThread = makeThread('run-a', [
      makeMessage({
        id: 'wa',
        threadId: 'run-a',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Run A Page', pageKind: 'entity', wikiName: 'personal' },
        createdAt: '2026-11-18T10:01:00.000Z',
      }),
    ]);
    const progress: TaskProgressEntryLike = {
      taskId: 'task-1',
      outcome: 'done',
      summary: 'Committed the labeler script',
      filesChanged: ['labeler.ts'],
      commitShas: ['abc123'],
      completedAt: '2026-11-18T10:02:00.000Z',
    };

    const result = buildTaskRunReport('task-1', {
      workspaceStore: fakeWorkspaceStore({
        task,
        workspace,
        runs: [makeRun({ id: 'run-a', threadId: 'run-a' })],
        progressEntries: [progress],
      }),
      threadStore: { getThread: (id: string) => (id === 'run-a' ? runThread : null) },
      observabilityStore,
    });

    expect(result?.progressEntries).to.deep.equal([progress]);
    expect(result?.summary.wikiWriteCount).to.equal(1);
    expect(result?.summary.runCount).to.equal(1);
  });
});
