import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { makeReadTaskRunTool } from './read-task-run.tool.js';

describe('agents/tools/read-task-run', () => {
  let dir: string;
  let taskId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-task-run-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    taskId = getWorkspaceStore().createTask({ title: 'Nightly summary' }).id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A finished run whose thread holds `count` assistant messages
  // ("message 1".."message N"), mirroring what task-execution.ts records.
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

  function currentRun(): string {
    return getWorkspaceStore().enqueueTask(taskId).id;
  }

  it('returns the previous run transcript with a header and an end-of-transcript footer [unit]', async () => {
    const previous = finishedRun(2);
    const result = (await makeReadTaskRunTool(taskId, currentRun()).invoke({
      runId: previous,
    })) as string;

    expect(result).to.include('Transcript of run #1 (done, started via manual)');
    expect(result).to.include('[Agent] message 1');
    expect(result).to.include('[Agent] message 2');
    expect(result).to.include('(messages 1–2 of 2; end of transcript)');
  });

  it('pages long transcripts and tells the agent exactly which offset to ask for next [unit]', async () => {
    const previous = finishedRun(5);
    const tool = makeReadTaskRunTool(taskId, currentRun());

    const first = (await tool.invoke({ runId: previous, limit: 2 })) as string;
    expect(first).to.include('message 2');
    expect(first).to.not.include('message 3');
    expect(first).to.include('(messages 1–2 of 5; call again with offset=2 for more)');

    const second = (await tool.invoke({ runId: previous, offset: 2, limit: 2 })) as string;
    expect(second).to.include('message 3');
    expect(second).to.include('(messages 3–4 of 5; call again with offset=4 for more)');
  });

  it('reports an offset past the end instead of returning an empty page [unit]', async () => {
    const previous = finishedRun(1);
    const result = (await makeReadTaskRunTool(taskId, currentRun()).invoke({
      runId: previous,
      offset: 5,
    })) as string;
    expect(result).to.include('offset 5 is past the end — this run has 1 messages');
  });

  it("refuses another task's run, so a task can only read its own history [unit]", async () => {
    const otherTask = getWorkspaceStore().createTask({ title: 'other' });
    const foreign = getWorkspaceStore().enqueueTask(otherTask.id);
    getWorkspaceStore().completeQueueEntry(foreign.id, 'done');

    const result = (await makeReadTaskRunTool(taskId, currentRun()).invoke({
      runId: foreign.id,
    })) as string;
    expect(result).to.include('belongs to this task');
  });

  it('refuses an unknown run id [unit]', async () => {
    const result = (await makeReadTaskRunTool(taskId, currentRun()).invoke({
      runId: 'nope',
    })) as string;
    expect(result).to.include('No run with id "nope"');
  });

  it('refuses the run the agent is currently in [unit]', async () => {
    const current = currentRun();
    const result = (await makeReadTaskRunTool(taskId, current).invoke({
      runId: current,
    })) as string;
    expect(result).to.include('currently in');
  });

  it('refuses a run that has not finished yet [unit]', async () => {
    const unfinished = getWorkspaceStore().enqueueTask(taskId).id;
    const result = (await makeReadTaskRunTool(taskId, currentRun()).invoke({
      runId: unfinished,
    })) as string;
    expect(result).to.include('has not finished yet (status: pending)');
  });

  it('falls back to the summary for a run recorded before per-run transcripts existed [unit]', async () => {
    const legacy = getWorkspaceStore().enqueueTask(taskId);
    getWorkspaceStore().setQueueEntrySummary(legacy.id, 'Old summary.');
    getWorkspaceStore().completeQueueEntry(legacy.id, 'done');

    const result = (await makeReadTaskRunTool(taskId, currentRun()).invoke({
      runId: legacy.id,
    })) as string;
    expect(result).to.include('predates per-run transcripts');
    expect(result).to.include('Old summary.');
  });
});
