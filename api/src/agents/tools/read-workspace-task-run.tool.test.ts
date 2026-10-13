import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { readWorkspaceTaskRunTool } from './read-workspace-task-run.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return { configurable: { thread_id: 'calling-thread', workspaceId }, toolCallId: 'call-1' };
}

describe('agents/tools/read-workspace-task-run', () => {
  let dir: string;
  let workspaceId: string;
  let taskId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-workspace-task-run-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    const store = getWorkspaceStore();
    workspaceId = store.createWorkspace({ name: 'Test Workspace', location: '/tmp/test-ws' }).id;
    taskId = store.createTask({ title: 'Nightly backup', workspaceId }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function finishedRun(count: number, outcome: 'done' | 'failed' = 'done'): string {
    const store = getWorkspaceStore();
    const threads = getThreadStore();
    const entry = store.enqueueTask(taskId);
    const threadId = `run-thread-${entry.id}`;
    store.setQueueEntryThread(entry.id, threadId);
    threads.upsertThreadOnFirstMessage(threadId, 'run', 'task');
    for (let i = 1; i <= count; i++) {
      threads.insertMessage(threadId, {
        id: `${entry.id}-m${i}`,
        kind: 'assistant',
        payload: { content: `message ${i}` },
      });
    }
    store.completeQueueEntry(entry.id, outcome);
    return entry.id;
  }

  it('rejects when no workspace is active [unit]', async () => {
    const result = await readWorkspaceTaskRunTool.invoke(
      { taskId, runId: 'whatever' },
      invokeConfig(undefined),
    );
    expect(String(result)).to.include('no active workspace');
  });

  it('refuses a task id that does not exist, same message as a task from another workspace [unit]', async () => {
    const unknown = await readWorkspaceTaskRunTool.invoke(
      { taskId: 'nope', runId: 'whatever' },
      invokeConfig(workspaceId),
    );

    const otherWorkspaceId = getWorkspaceStore().createWorkspace({
      name: 'Other Workspace',
      location: '/tmp/other-ws',
    }).id;
    const foreignTaskId = getWorkspaceStore().createTask({
      title: 'Not yours',
      workspaceId: otherWorkspaceId,
    }).id;
    const foreign = await readWorkspaceTaskRunTool.invoke(
      { taskId: foreignTaskId, runId: 'whatever' },
      invokeConfig(workspaceId),
    );

    expect(String(unknown)).to.equal(`No task with id "nope" in this workspace.`);
    expect(String(foreign)).to.equal(`No task with id "${foreignTaskId}" in this workspace.`);
  });

  it('refuses a run id that does not belong to the given task [unit]', async () => {
    const otherTaskId = getWorkspaceStore().createTask({ title: 'other', workspaceId }).id;
    const foreignRun = getWorkspaceStore().enqueueTask(otherTaskId);
    getWorkspaceStore().completeQueueEntry(foreignRun.id, 'done');

    const result = await readWorkspaceTaskRunTool.invoke(
      { taskId, runId: foreignRun.id },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.include(`No run with id "${foreignRun.id}"`);
  });

  it('refuses a run that has not finished yet [unit]', async () => {
    const unfinished = getWorkspaceStore().enqueueTask(taskId).id;
    const result = await readWorkspaceTaskRunTool.invoke(
      { taskId, runId: unfinished },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.include('has not finished yet (status: pending)');
  });

  it('falls back to the summary for a run recorded before per-run transcripts existed [unit]', async () => {
    const legacy = getWorkspaceStore().enqueueTask(taskId);
    getWorkspaceStore().setQueueEntrySummary(legacy.id, 'Old summary.');
    getWorkspaceStore().completeQueueEntry(legacy.id, 'done');

    const result = await readWorkspaceTaskRunTool.invoke(
      { taskId, runId: legacy.id },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.include('predates per-run transcripts');
    expect(String(result)).to.include('Old summary.');
  });

  it("returns the run's transcript with a header and footer [unit]", async () => {
    const run = finishedRun(2, 'failed');
    const result = await readWorkspaceTaskRunTool.invoke(
      { taskId, runId: run },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.include('Transcript of run #1 (failed, started via manual)');
    expect(String(result)).to.include('[Agent] message 1');
    expect(String(result)).to.include('(messages 1–2 of 2; end of transcript)');
  });
});
