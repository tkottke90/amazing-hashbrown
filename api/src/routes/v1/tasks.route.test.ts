import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { tasksRouter } from './tasks.route.js';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore } from '../../services/thread-store.js';
import { bootTaskScheduler, getTaskScheduler } from '../../services/task-scheduler.js';
import { bootCronRegistry, getCronRegistry } from '../../services/cron-registry.js';

enum TestTypes {
  ORCHESTRATION = '[orchestration]',
}

// Proves the Kanban board's routes are wired end to end: every task the API
// hands the UI carries its `board`, and a move wakes the scheduler and
// re-syncs the task's cron timer the same way PATCH does — without that, a
// dragged-to-Queue card would sit until some unrelated event woke the queue.
describe('routes/v1/tasks.route — Kanban board', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;
  let wakes: number;
  let syncs: string[];

  before(async () => {
    ({ baseUrl, close } = await startTestServer(tasksRouter, '/api/v1/tasks'));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tasks-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    bootCronRegistry({ setTimer: () => 0, clearTimer: () => {} });
    // No executor: nothing actually runs, so the state a move leaves behind
    // is exactly what the handler produced.
    bootTaskScheduler();

    wakes = 0;
    syncs = [];
    getTaskScheduler().wake = () => {
      wakes++;
    };
    const registry = getCronRegistry();
    const originalSync = registry.sync.bind(registry);
    registry.sync = (taskId: string) => {
      syncs.push(taskId);
      originalSync(taskId);
    };
  });

  afterEach(() => {
    getCronRegistry().stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function post(path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it(`GET / returns every task with its board projection ${TestTypes.ORCHESTRATION}`, async () => {
    getWorkspaceStore().createTask({ title: 'Backlog task', assignedTo: 'agent' });

    const res = await fetch(`${baseUrl}/`);
    const tasks = (await res.json()) as Array<{ board: { lane: string; moves: unknown[] } }>;

    expect(res.status).to.equal(200);
    expect(tasks[0]!.board.lane).to.equal('backlog');
    expect(tasks[0]!.board.moves).to.deep.include({ to: 'queue', needs: 'none' });
  });

  it(`GET /:id returns the task with its board projection ${TestTypes.ORCHESTRATION}`, async () => {
    const task = getWorkspaceStore().createTask({ title: 't', assignedTo: 'user' });

    const res = await fetch(`${baseUrl}/${task.id}`);
    const body = (await res.json()) as { board: { reason: { kind: string } } };

    expect(body.board.reason.kind).to.equal('assigned_to_user');
  });

  it(`PATCH /:id returns the patched task with a fresh board ${TestTypes.ORCHESTRATION}`, async () => {
    const task = getWorkspaceStore().createTask({ title: 't', assignedTo: 'agent' });

    const res = await fetch(`${baseUrl}/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    const body = (await res.json()) as { board: { lane: string } };

    expect(body.board.lane).to.equal('done');
  });

  it(`POST /:id/move executes the move, wakes the scheduler and syncs the cron timer ${TestTypes.ORCHESTRATION}`, async () => {
    const task = getWorkspaceStore().createTask({ title: 't', assignedTo: 'agent' });

    const res = await post(`/${task.id}/move`, { to: 'queue' });
    const body = (await res.json()) as { status: string; board: { lane: string } };

    expect(res.status).to.equal(200);
    expect(body.status).to.equal('ready');
    expect(body.board.lane).to.equal('queue');
    expect(wakes, 'the scheduler must pick the task up immediately').to.equal(1);
    expect(syncs).to.deep.equal([task.id]);
  });

  it(`POST /:id/move returns 409 with the reason for an illegal move and wakes nothing ${TestTypes.ORCHESTRATION}`, async () => {
    const task = getWorkspaceStore().createTask({ title: 't', assignedTo: 'agent' });

    const res = await post(`/${task.id}/move`, { to: 'attention' });
    const body = (await res.json()) as { error: string };

    expect(res.status).to.equal(409);
    expect(body.error).to.match(/Needs attention/);
    expect(wakes).to.equal(0);
  });

  it(`POST /:id/move returns 400 for a malformed body ${TestTypes.ORCHESTRATION}`, async () => {
    const task = getWorkspaceStore().createTask({ title: 't' });

    const res = await post(`/${task.id}/move`, { to: 'queue', position: -1 });

    expect(res.status).to.equal(400);
  });
});
