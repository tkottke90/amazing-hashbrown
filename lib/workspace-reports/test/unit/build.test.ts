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
import { buildWorkspaceRetrospective } from '../../src/build.js';
import type {
  WorkspaceLike,
  TaskLike,
  TaskRunLike,
  FailedRunStreakLike,
  TaskProgressEntryLike,
  WorkspaceStoreLike,
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
    createdAt: '2026-07-18T09:00:00.000Z',
    updatedAt: '2026-07-18T09:00:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    messages,
  };
}

interface FakeWorkspaceStoreFixtures {
  workspace: WorkspaceLike | null;
  tasks?: TaskLike[];
  runsByTask?: Record<string, TaskRunLike[]>;
  failedStreaks?: Map<string, FailedRunStreakLike>;
  progressEntries?: TaskProgressEntryLike[];
}

function fakeWorkspaceStore(fixtures: FakeWorkspaceStoreFixtures): WorkspaceStoreLike {
  return {
    getWorkspace: () => fixtures.workspace,
    listTasks: () => fixtures.tasks ?? [],
    listTaskRuns: (taskId: string) => fixtures.runsByTask?.[taskId] ?? [],
    failedRunStreaks: () => fixtures.failedStreaks ?? new Map(),
    listTaskProgressEntriesForWorkspace: () => fixtures.progressEntries ?? [],
  };
}

function makeWorkspace(overrides: Partial<WorkspaceLike> = {}): WorkspaceLike {
  return {
    id: 'ws-1',
    name: 'Gmail Labeler',
    goal: 'Automatically label incoming Gmail messages',
    wikiId: 'personal',
    threadId: 'chat-thread',
    createdAt: '2026-07-18T08:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskLike> = {}): TaskLike {
  return {
    id: 'task-1',
    title: 'Build labeler automation',
    status: 'done',
    origin: 'agent',
    provider: 'ollama',
    model: 'qwen3:14b',
    trackerType: null,
    trackerId: null,
    ...overrides,
  };
}

describe('build/buildWorkspaceRetrospective', () => {
  let observabilityStore: ObservabilityStore;
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-reports-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    observabilityStore = new ObservabilityStore(db);
  });

  after(() => {
    rmSync(dir, { recursive: true });
  });

  it(`returns null when the workspace does not exist ${TestTypes.UNIT}`, () => {
    const result = buildWorkspaceRetrospective('missing', {
      workspaceStore: fakeWorkspaceStore({ workspace: null }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });
    expect(result).to.equal(null);
  });

  it(`builds a report with no chat thread and no tasks ${TestTypes.UNIT}`, () => {
    const workspace = makeWorkspace({ threadId: null });
    const result = buildWorkspaceRetrospective('ws-1', {
      workspaceStore: fakeWorkspaceStore({ workspace }),
      threadStore: { getThread: () => null },
      observabilityStore,
    });
    expect(result).to.not.equal(null);
    expect(result?.chat).to.equal(null);
    expect(result?.tasks).to.deep.equal([]);
    expect(result?.summary).to.deep.equal({
      taskCount: 0,
      runCount: 0,
      failureCount: 0,
      wikiWriteCount: 0,
      anomalyCount: 0,
    });
  });

  it(`flags a wiki_update whose wikiName does not match the workspace wikiId ${TestTypes.UNIT}`, () => {
    const workspace = makeWorkspace({ wikiId: 'personal' });
    const chatThread = makeThread('chat-thread', [
      makeMessage({
        id: 'w1',
        threadId: 'chat-thread',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Minecraft', pageKind: 'entity', wikiName: 'work' },
        createdAt: '2026-07-18T10:00:00.000Z',
      }),
    ]);

    const result = buildWorkspaceRetrospective('ws-1', {
      workspaceStore: fakeWorkspaceStore({ workspace }),
      threadStore: { getThread: (id: string) => (id === 'chat-thread' ? chatThread : null) },
      observabilityStore,
    });

    expect(result?.anomalies).to.have.length(1);
    expect(result?.anomalies[0]).to.deep.include({
      kind: 'wiki_mismatch',
      actualWikiName: 'work',
      expectedWikiId: 'personal',
    });
  });

  it(`does not flag a wiki_update that matches the workspace wikiId ${TestTypes.UNIT}`, () => {
    const workspace = makeWorkspace({ wikiId: 'personal' });
    const chatThread = makeThread('chat-thread', [
      makeMessage({
        id: 'w1',
        threadId: 'chat-thread',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Minecraft', pageKind: 'entity', wikiName: 'personal' },
        createdAt: '2026-07-18T10:00:00.000Z',
      }),
    ]);

    const result = buildWorkspaceRetrospective('ws-1', {
      workspaceStore: fakeWorkspaceStore({ workspace }),
      threadStore: { getThread: (id: string) => (id === 'chat-thread' ? chatThread : null) },
      observabilityStore,
    });

    expect(result?.anomalies).to.have.length(0);
  });

  it(`flags a recursion-guard escalation inside a task run thread, tagged with its taskId ${TestTypes.UNIT}`, () => {
    const workspace = makeWorkspace({ threadId: null });
    const task = makeTask({ id: 'task-1' });
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
        createdAt: '2026-07-18T10:05:00.000Z',
      }),
    ]);
    const run: TaskRunLike = {
      id: 'run-1',
      runNumber: 1,
      status: 'paused',
      summary: null,
      recoveryAttempts: 0,
      threadId: 'run-thread-1',
      enqueuedAt: '2026-07-18T10:00:00.000Z',
    };

    const result = buildWorkspaceRetrospective('ws-1', {
      workspaceStore: fakeWorkspaceStore({
        workspace,
        tasks: [task],
        runsByTask: { 'task-1': [run] },
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
    const workspace = makeWorkspace({ threadId: null });
    const task = makeTask({ id: 'task-1', title: 'Flaky task' });

    const result = buildWorkspaceRetrospective('ws-1', {
      workspaceStore: fakeWorkspaceStore({
        workspace,
        tasks: [task],
        runsByTask: { 'task-1': [] },
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

  it(`attaches only a task's own progress entries, and aggregates wiki-write/failure totals across chat and runs ${TestTypes.UNIT}`, () => {
    const workspace = makeWorkspace({ threadId: 'chat-thread', wikiId: 'personal' });
    const chatThread = makeThread('chat-thread', [
      makeMessage({
        id: 'w1',
        threadId: 'chat-thread',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Chat Page', pageKind: 'entity', wikiName: 'personal' },
        createdAt: '2026-07-18T10:00:00.000Z',
      }),
    ]);
    const taskA = makeTask({ id: 'task-a', title: 'Task A' });
    const taskB = makeTask({ id: 'task-b', title: 'Task B' });
    const runThreadA = makeThread('run-a', [
      makeMessage({
        id: 'wa',
        threadId: 'run-a',
        seq: 1,
        kind: 'wiki_update',
        payload: { pageTitle: 'Run A Page', pageKind: 'entity', wikiName: 'personal' },
        createdAt: '2026-07-18T10:01:00.000Z',
      }),
    ]);
    const progressA: TaskProgressEntryLike = {
      taskId: 'task-a',
      outcome: 'done',
      summary: 'Committed the labeler script',
      filesChanged: ['labeler.ts'],
      commitShas: ['abc123'],
      completedAt: '2026-07-18T10:02:00.000Z',
    };
    const progressB: TaskProgressEntryLike = {
      taskId: 'task-b',
      outcome: 'failed',
      summary: 'Ran out of tool budget',
      filesChanged: [],
      commitShas: [],
      completedAt: '2026-07-18T10:03:00.000Z',
    };

    const result = buildWorkspaceRetrospective('ws-1', {
      workspaceStore: fakeWorkspaceStore({
        workspace,
        tasks: [taskA, taskB],
        runsByTask: {
          'task-a': [
            {
              id: 'run-a',
              runNumber: 1,
              status: 'done',
              summary: 'Done',
              recoveryAttempts: 0,
              threadId: 'run-a',
              enqueuedAt: '2026-07-18T10:00:30.000Z',
            },
          ],
          'task-b': [],
        },
        progressEntries: [progressA, progressB],
      }),
      threadStore: {
        getThread: (id: string) => {
          if (id === 'chat-thread') return chatThread;
          if (id === 'run-a') return runThreadA;
          return null;
        },
      },
      observabilityStore,
    });

    const byId = new Map(result?.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('task-a')?.progressEntries).to.deep.equal([progressA]);
    expect(byId.get('task-b')?.progressEntries).to.deep.equal([progressB]);
    // one wiki_update in chat + one in run-a's thread
    expect(result?.summary.wikiWriteCount).to.equal(2);
    expect(result?.summary.taskCount).to.equal(2);
    expect(result?.summary.runCount).to.equal(1);
  });
});
