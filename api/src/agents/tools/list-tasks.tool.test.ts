import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { listTasksTool } from './list-tasks.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return { configurable: { thread_id: 'calling-thread', workspaceId }, toolCallId: 'call-1' };
}

describe('agents/tools/list-tasks', () => {
  let dir: string;
  let workspaceId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'list-tasks-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    workspaceId = getWorkspaceStore().createWorkspace({
      name: 'Test Workspace',
      location: '/tmp/test-ws',
    }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects when no workspace is active [unit]', async () => {
    const result = await listTasksTool.invoke({}, invokeConfig(undefined));
    expect(String(result)).to.include('no active workspace');
  });

  it('never returns a task from another workspace [unit]', async () => {
    const store = getWorkspaceStore();
    store.createTask({ title: 'Mine', workspaceId });
    const otherWorkspaceId = store.createWorkspace({
      name: 'Other',
      location: '/tmp/other-ws',
    }).id;
    store.createTask({ title: 'Not mine', workspaceId: otherWorkspaceId });

    const result = await listTasksTool.invoke({}, invokeConfig(workspaceId));
    expect(String(result)).to.include('Mine');
    expect(String(result)).to.not.include('Not mine');
  });

  it('filters by status and by a case-insensitive title substring [unit]', async () => {
    const store = getWorkspaceStore();
    const a = store.createTask({ title: 'Nightly dependency audit', workspaceId });
    const b = store.createTask({ title: 'Weekly cleanup', workspaceId });
    store.completeQueueEntry(store.enqueueTask(a.id).id, 'failed');
    store.completeQueueEntry(store.enqueueTask(b.id).id, 'done');

    const byStatus = await listTasksTool.invoke({ status: 'failed' }, invokeConfig(workspaceId));
    expect(String(byStatus)).to.include('Nightly dependency audit');
    expect(String(byStatus)).to.not.include('Weekly cleanup');

    const byTitle = await listTasksTool.invoke(
      { titleContains: 'nightly' },
      invokeConfig(workspaceId),
    );
    expect(String(byTitle)).to.include('Nightly dependency audit');
    expect(String(byTitle)).to.not.include('Weekly cleanup');
  });

  it('inlines the failed-run streak only for failed/blocked tasks [unit]', async () => {
    const store = getWorkspaceStore();
    const failing = store.createTask({ title: 'Flaky job', workspaceId });
    const run = store.enqueueTask(failing.id);
    store.setQueueEntrySummary(run.id, 'Run failed: rate limit exceeded');
    store.completeQueueEntry(run.id, 'failed');

    const ok = store.createTask({ title: 'Healthy job', workspaceId });
    store.completeQueueEntry(store.enqueueTask(ok.id).id, 'done');

    const result = String(await listTasksTool.invoke({}, invokeConfig(workspaceId)));
    expect(result).to.include('Flaky job');
    expect(result).to.include('failed 1x, last: Run failed: rate limit exceeded');
    expect(result).to.include('Healthy job');
    expect(result).to.not.match(/Healthy job.*failed \d+x/);
  });

  it('names the applied filters instead of returning an empty response [unit]', async () => {
    const result = await listTasksTool.invoke(
      { status: 'failed', titleContains: 'backup' },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.equal('No tasks match (status: failed, title contains "backup").');
  });

  it('paginates and names the exact offset to ask for next [unit]', async () => {
    const store = getWorkspaceStore();
    for (let i = 1; i <= 3; i++) {
      store.createTask({ title: `Task ${i}`, workspaceId });
    }

    const first = String(await listTasksTool.invoke({ limit: 2 }, invokeConfig(workspaceId)));
    expect(first).to.include('(tasks 1–2 of 3; call again with offset=2 for more)');

    const second = String(
      await listTasksTool.invoke({ limit: 2, offset: 2 }, invokeConfig(workspaceId)),
    );
    expect(second).to.include('(tasks 3–3 of 3)');
  });
});
