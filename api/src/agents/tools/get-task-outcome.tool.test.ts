import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { getTaskOutcomeTool } from './get-task-outcome.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return { configurable: { thread_id: 'calling-thread', workspaceId }, toolCallId: 'call-1' };
}

describe('agents/tools/get-task-outcome', () => {
  let dir: string;
  let workspaceId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'get-task-outcome-tool-test-'));
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
    const result = await getTaskOutcomeTool.invoke({ taskId: 'x' }, invokeConfig(undefined));
    expect(String(result)).to.include('no active workspace');
  });

  it('refuses an unknown task id, same message as a task from another workspace [unit]', async () => {
    const store = getWorkspaceStore();
    const unknown = await getTaskOutcomeTool.invoke(
      { taskId: 'nope' },
      invokeConfig(workspaceId),
    );

    const otherWorkspaceId = store.createWorkspace({ name: 'Other', location: '/tmp/other' }).id;
    const foreignTaskId = store.createTask({
      title: 'Not yours',
      workspaceId: otherWorkspaceId,
    }).id;
    const foreign = await getTaskOutcomeTool.invoke(
      { taskId: foreignTaskId },
      invokeConfig(workspaceId),
    );

    expect(String(unknown)).to.equal('No task with id "nope" in this workspace.');
    expect(String(foreign)).to.equal(`No task with id "${foreignTaskId}" in this workspace.`);
  });

  it('reports a task with no runs yet without fabricating a summary [unit]', async () => {
    const store = getWorkspaceStore();
    const task = store.createTask({ title: 'Brand new task', workspaceId });

    const result = String(
      await getTaskOutcomeTool.invoke({ taskId: task.id }, invokeConfig(workspaceId)),
    );
    expect(result).to.include('"Brand new task" — status: pending');
    expect(result).to.include('Has not run yet.');
  });

  it('reports a currently running task plainly, without a summary that does not exist yet [unit]', async () => {
    const store = getWorkspaceStore();
    const task = store.createTask({ title: 'In flight', workspaceId });
    store.enqueueTask(task.id);
    store.patchTask(task.id, { status: 'running' });

    const result = String(
      await getTaskOutcomeTool.invoke({ taskId: task.id }, invokeConfig(workspaceId)),
    );
    expect(result).to.include('status: running');
    expect(result).to.include('Currently running');
    expect(result).to.not.include('summary recorded');
  });

  it('reports a successful task with its latest summary [unit]', async () => {
    const store = getWorkspaceStore();
    const task = store.createTask({ title: 'Weekly report', workspaceId });
    const run = store.enqueueTask(task.id);
    store.setQueueEntrySummary(run.id, 'Sent the report to 3 recipients.');
    store.completeQueueEntry(run.id, 'done');

    const result = String(
      await getTaskOutcomeTool.invoke({ taskId: task.id }, invokeConfig(workspaceId)),
    );
    expect(result).to.include('status: done');
    expect(result).to.include('Completed successfully');
    expect(result).to.include('Sent the report to 3 recipients.');
  });

  it('reports a failed task with its summary and the failed-run streak [unit]', async () => {
    const store = getWorkspaceStore();
    const task = store.createTask({ title: 'Flaky sync', workspaceId });
    const run1 = store.enqueueTask(task.id);
    store.setQueueEntrySummary(run1.id, 'Run failed: timeout.');
    store.completeQueueEntry(run1.id, 'failed');
    const run2 = store.enqueueTask(task.id);
    store.setQueueEntrySummary(run2.id, 'Run failed: rate limit exceeded.');
    store.completeQueueEntry(run2.id, 'failed');

    const result = String(
      await getTaskOutcomeTool.invoke({ taskId: task.id }, invokeConfig(workspaceId)),
    );
    expect(result).to.include('status: failed');
    expect(result).to.include('Run failed: rate limit exceeded.');
    expect(result).to.include('Failed 2x in a row. Last: Run failed: rate limit exceeded.');
  });

  it('reports a blocked task with its blockedReason [unit]', async () => {
    const store = getWorkspaceStore();
    const task = store.createTask({ title: 'Dependent task', workspaceId });
    store.enqueueTask(task.id);
    store.patchTask(task.id, { status: 'blocked', blockedReason: 'dependency_failed' });

    const result = String(
      await getTaskOutcomeTool.invoke({ taskId: task.id }, invokeConfig(workspaceId)),
    );
    expect(result).to.include('status: blocked');
    expect(result).to.include('Blocked (dependency_failed)');
  });

  it('lists past runs for drill-down and points at read_workspace_task_run [unit]', async () => {
    const store = getWorkspaceStore();
    const task = store.createTask({ title: 'Recurring job', workspaceId });
    const run = store.enqueueTask(task.id);
    store.completeQueueEntry(run.id, 'done');

    const result = String(
      await getTaskOutcomeTool.invoke({ taskId: task.id }, invokeConfig(workspaceId)),
    );
    expect(result).to.include('Past runs (1 of 1 shown)');
    expect(result).to.include(run.id);
    expect(result).to.include('read_workspace_task_run');
  });
});
