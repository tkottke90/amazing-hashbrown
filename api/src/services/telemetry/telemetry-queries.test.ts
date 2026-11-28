import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import { ThreadStore } from '../thread-store.js';
import { WorkspaceStore } from '../workspace-store.js';
import { CONTINUE_CHOICE, STOP_AND_SUMMARIZE_CHOICE } from '../../agents/loop-guard-choices.js';

// One shared database with all three stores, exactly as production wires them
// — the telemetry views join across store-owned tables.
interface Fixture {
  dir: string;
  db: SqliteDatabase;
  threads: ThreadStore;
  workspaces: WorkspaceStore;
  obs: ObservabilityStore;
}

let fx: Fixture;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-queries-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  fx = {
    dir,
    db,
    threads: new ThreadStore(db),
    obs: new ObservabilityStore(db),
    workspaces: new WorkspaceStore(db),
  };
});

afterEach(() => {
  fx.db.close();
  rmSync(fx.dir, { recursive: true });
});

// A done/failed/... Run of a Task, in its own run thread, with fixed timestamps
// so durations are deterministic.
function addRun(
  taskId: string,
  opts: {
    status: string;
    threadId?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
  },
): string {
  const entry = fx.workspaces.enqueueTask(taskId);
  const threadId = opts.threadId ?? `run-${entry.id}`;
  fx.threads.ensureThreadExists(threadId, 'task');
  fx.workspaces.setQueueEntryThread(entry.id, threadId);
  fx.db
    .prepare(`UPDATE task_queue SET status = ?, started_at = ?, finished_at = ? WHERE id = ?`)
    .run(
      opts.status,
      opts.startedAt === undefined ? '2026-01-01T00:00:00.000Z' : opts.startedAt,
      opts.finishedAt === undefined ? '2026-01-01T00:01:00.000Z' : opts.finishedAt,
      entry.id,
    );
  return threadId;
}

function addPrompt(
  threadId: string,
  id: string,
  opts: {
    kind?: string;
    status?: 'pending' | 'answered';
    answer?: string;
    extra?: Record<string, unknown>;
  } = {},
): void {
  fx.threads.insertMessage(threadId, {
    id,
    kind: 'hitl_prompt',
    status: opts.status ?? 'answered',
    payload: {
      promptId: id,
      kind: opts.kind ?? 'loop_stagnation_warning',
      ...(opts.answer !== undefined ? { answer: opts.answer } : {}),
      ...opts.extra,
    },
  });
}

describe('services/thread-store queryLoopGuardEscalations', () => {
  it('buckets answers into continue, stop_and_summarize, custom and pending [unit]', () => {
    fx.threads.ensureThreadExists('t', 'chat');
    addPrompt('t', 'p1', { answer: CONTINUE_CHOICE });
    addPrompt('t', 'p2', { answer: STOP_AND_SUMMARIZE_CHOICE });
    addPrompt('t', 'p3', { answer: 'try the other API instead' });
    addPrompt('t', 'p4', { status: 'pending' });

    const byAnswer = Object.fromEntries(
      fx.threads.queryLoopGuardEscalations().map((r) => [r.answer, r.count]),
    );
    expect(byAnswer).to.deep.equal({
      continue: 1,
      stop_and_summarize: 1,
      custom: 1,
      pending: 1,
    });
  });

  it('ignores prompts that are not loop-guard escalations [unit]', () => {
    fx.threads.ensureThreadExists('t', 'chat');
    addPrompt('t', 'ask', { kind: 'free_text', answer: 'hi' });
    addPrompt('t', 'shell', { kind: 'shell_approval', answer: 'yes' });

    expect(fx.threads.queryLoopGuardEscalations()).to.deep.equal([]);
  });

  it('keeps the escalation kind and owning thread type as separate series [unit]', () => {
    fx.threads.ensureThreadExists('chat-thread', 'chat');
    fx.threads.ensureThreadExists('run-thread', 'task');
    addPrompt('chat-thread', 'p1', { kind: 'recursion_limit_warning', answer: CONTINUE_CHOICE });
    addPrompt('run-thread', 'p2', { kind: 'loop_stagnation_warning', answer: CONTINUE_CHOICE });

    const rows = fx.threads.queryLoopGuardEscalations();
    expect(rows).to.have.deep.members([
      { kind: 'recursion_limit_warning', context: 'chat', answer: 'continue', count: 1 },
      { kind: 'loop_stagnation_warning', context: 'task', answer: 'continue', count: 1 },
    ]);
  });

  it('does not count a mirrored copy of a task prompt a second time [unit]', () => {
    fx.threads.ensureThreadExists('run-thread', 'task');
    fx.threads.ensureThreadExists('workspace-thread', 'workspace-chat');
    addPrompt('run-thread', 'orig', { answer: CONTINUE_CHOICE });
    addPrompt('workspace-thread', 'copy', {
      answer: CONTINUE_CHOICE,
      extra: { sourcePromptId: 'orig', runThreadId: 'run-thread' },
    });

    const total = fx.threads.queryLoopGuardEscalations().reduce((n, r) => n + r.count, 0);
    expect(total, 'the mirror copy must not inflate the count').to.equal(1);
  });

  it('drops an escalation when its thread is deleted [unit]', () => {
    fx.threads.ensureThreadExists('t', 'chat');
    addPrompt('t', 'p1', { answer: CONTINUE_CHOICE });
    fx.threads.deleteThread('t');

    expect(fx.threads.queryLoopGuardEscalations()).to.deep.equal([]);
  });
});

describe('services/workspace-store queryEscalationOutcomes', () => {
  function outcomesFor(runStatus: string): Array<{ answer: string; outcome: string }> {
    const task = fx.workspaces.createTask({ title: 'T' });
    const thread = addRun(task.id, { status: runStatus });
    addPrompt(thread, 'p', { answer: STOP_AND_SUMMARIZE_CHOICE });
    return fx.workspaces.queryEscalationOutcomes();
  }

  it('maps a done Run to the done outcome [unit]', () => {
    expect(outcomesFor('done')).to.deep.equal([
      { answer: 'stop_and_summarize', outcome: 'done', count: 1 },
    ]);
  });

  it('maps a handed-off Run to the blocked outcome [unit]', () => {
    expect(outcomesFor('handed_off')).to.deep.equal([
      { answer: 'stop_and_summarize', outcome: 'blocked', count: 1 },
    ]);
  });

  it('maps any other Run status, including one still running, to other [unit]', () => {
    for (const status of ['failed', 'cancelled', 'running']) {
      const task = fx.workspaces.createTask({ title: `T-${status}` });
      const thread = addRun(task.id, { status });
      addPrompt(thread, `p-${status}`, { answer: CONTINUE_CHOICE });
    }
    expect(fx.workspaces.queryEscalationOutcomes()).to.deep.equal([
      { answer: 'continue', outcome: 'other', count: 3 },
    ]);
  });

  it('excludes a prompt that is still unanswered [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    const thread = addRun(task.id, { status: 'running' });
    addPrompt(thread, 'p', { status: 'pending' });

    expect(fx.workspaces.queryEscalationOutcomes()).to.deep.equal([]);
  });

  it('excludes answered prompts that are not loop-guard escalations [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    const thread = addRun(task.id, { status: 'done' });
    addPrompt(thread, 'p', { kind: 'free_text', answer: 'ok' });

    expect(fx.workspaces.queryEscalationOutcomes()).to.deep.equal([]);
  });

  it('excludes a mirrored copy even if it sits in a thread that also holds a Run [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    const thread = addRun(task.id, { status: 'done' });
    addPrompt(thread, 'copy', {
      answer: CONTINUE_CHOICE,
      extra: { sourcePromptId: 'orig' },
    });

    expect(fx.workspaces.queryEscalationOutcomes()).to.deep.equal([]);
  });
});

describe('services/workspace-store queryTaskRunDurations', () => {
  function addTrace(
    threadId: string,
    source: string,
    provider: string,
    model: string,
    startedAt: string,
  ): void {
    const traceId = fx.obs.startTrace({
      threadId,
      provider,
      model,
      source: source as 'task-run',
    });
    fx.db
      .prepare(`UPDATE observability_traces SET started_at = ? WHERE trace_id = ?`)
      .run(startedAt, traceId);
  }

  it('sums wall-clock seconds and counts Runs per provider/model [unit]', () => {
    for (const seconds of [60, 120]) {
      const task = fx.workspaces.createTask({ title: `T${seconds}` });
      const end = new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
      const thread = addRun(task.id, { status: 'done', finishedAt: end });
      addTrace(thread, 'task-run', 'ollama', 'qwen', '2026-01-01T00:00:00.000Z');
    }

    const [row] = fx.workspaces.queryTaskRunDurations();
    expect(row).to.include({ provider: 'ollama', model: 'qwen', count: 2 });
    expect(row.seconds).to.be.closeTo(180, 0.01);
  });

  it("attributes a Run to its task-run trace, not the loop guard's reflection trace [unit]", () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    const thread = addRun(task.id, { status: 'done' });
    addTrace(thread, 'loop-guard', 'anthropic', 'judge-model', '2026-01-01T00:00:00.000Z');
    addTrace(thread, 'task-run', 'ollama', 'qwen', '2026-01-01T00:00:30.000Z');

    const rows = fx.workspaces.queryTaskRunDurations();
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ provider: 'ollama', model: 'qwen' });
  });

  it('counts a resumed Run once, using its earliest task-run trace [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    const thread = addRun(task.id, { status: 'done' });
    addTrace(thread, 'task-run', 'ollama', 'first-model', '2026-01-01T00:00:00.000Z');
    addTrace(thread, 'task-run', 'ollama', 'resumed-model', '2026-01-01T00:00:40.000Z');

    const rows = fx.workspaces.queryTaskRunDurations();
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ model: 'first-model', count: 1 });
  });

  it('keeps a Run with no trace under unknown rather than dropping it [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    addRun(task.id, { status: 'done' });

    expect(fx.workspaces.queryTaskRunDurations()[0]).to.include({
      provider: 'unknown',
      model: 'unknown',
      count: 1,
    });
  });

  it('skips a Run that has not finished [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    addRun(task.id, { status: 'running', finishedAt: null });

    expect(fx.workspaces.queryTaskRunDurations()).to.deep.equal([]);
  });
});

describe('services/workspace-store queryDoneTaskRunStats', () => {
  it('counts every Run, whatever its status, of a done board Task [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    addRun(task.id, { status: 'failed' });
    addRun(task.id, { status: 'cancelled' });
    addRun(task.id, { status: 'done' });
    fx.workspaces.patchTask(task.id, { status: 'done' });

    expect(fx.workspaces.queryDoneTaskRunStats()).to.deep.equal({ tasks: 1, runs: 3 });
  });

  it('ignores Tasks that are not done [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    addRun(task.id, { status: 'done' });

    expect(fx.workspaces.queryDoneTaskRunStats()).to.deep.equal({ tasks: 0, runs: 0 });
  });

  it('excludes Sub-Agent Tasks [unit]', () => {
    const sub = fx.workspaces.createTask({
      title: 'sub',
      origin: 'agent',
      parentThreadId: 'parent-thread',
    });
    addRun(sub.id, { status: 'done' });
    fx.workspaces.patchTask(sub.id, { status: 'done' });

    expect(fx.workspaces.queryDoneTaskRunStats()).to.deep.equal({ tasks: 0, runs: 0 });
  });

  it('drops a deleted Task and its Runs from the totals [unit]', () => {
    const task = fx.workspaces.createTask({ title: 'T' });
    addRun(task.id, { status: 'done' });
    fx.workspaces.patchTask(task.id, { status: 'done' });
    fx.workspaces.deleteTask(task.id);

    expect(fx.workspaces.queryDoneTaskRunStats()).to.deep.equal({ tasks: 0, runs: 0 });
  });
});

describe('services/workspace-store queryDonePlanStats', () => {
  const plan = (n: number) => Array.from({ length: n }, (_, i) => ({ step: `s${i}`, done: true }));

  it('totals plan steps across done Tasks that have a plan [unit]', () => {
    for (const n of [2, 4]) {
      const task = fx.workspaces.createTask({ title: `T${n}`, plan: plan(n) });
      fx.workspaces.patchTask(task.id, { status: 'done' });
    }

    expect(fx.workspaces.queryDonePlanStats()).to.deep.equal({ tasksWithPlan: 2, planSteps: 6 });
  });

  it('skips done Tasks with a null or empty plan so they do not drag the average down [unit]', () => {
    const noPlan = fx.workspaces.createTask({ title: 'none' });
    const empty = fx.workspaces.createTask({ title: 'empty', plan: [] });
    for (const t of [noPlan, empty]) fx.workspaces.patchTask(t.id, { status: 'done' });

    expect(fx.workspaces.queryDonePlanStats()).to.deep.equal({ tasksWithPlan: 0, planSteps: 0 });
  });

  it('excludes Tasks that are not done and Sub-Agent Tasks [unit]', () => {
    fx.workspaces.createTask({ title: 'open', plan: plan(3) });
    const sub = fx.workspaces.createTask({
      title: 'sub',
      plan: plan(5),
      origin: 'agent',
      parentThreadId: 'p',
    });
    fx.workspaces.patchTask(sub.id, { status: 'done' });

    expect(fx.workspaces.queryDonePlanStats()).to.deep.equal({ tasksWithPlan: 0, planSteps: 0 });
  });
});
