import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { formatRunTranscript, FINISHED_RUN_STATUSES } from './task-run-transcript.js';

describe('agents/tools/task-run-transcript', () => {
  let dir: string;
  let taskId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-run-transcript-test-'));
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
  function finishedRun(count: number, outcome: 'done' | 'failed' = 'done') {
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
    return store.getTaskRun(entry.id)!;
  }

  it('marks done/failed/cancelled as finished and leaves every other status out [unit]', () => {
    expect(FINISHED_RUN_STATUSES.has('done')).to.equal(true);
    expect(FINISHED_RUN_STATUSES.has('failed')).to.equal(true);
    expect(FINISHED_RUN_STATUSES.has('cancelled')).to.equal(true);
    expect(FINISHED_RUN_STATUSES.has('running')).to.equal(false);
    expect(FINISHED_RUN_STATUSES.has('pending')).to.equal(false);
  });

  it('returns the full transcript with a header and an end-of-transcript footer [unit]', () => {
    const run = finishedRun(2);
    const result = formatRunTranscript(getThreadStore(), run, 0, 40);

    expect(result).to.include('Transcript of run #1 (done, started via manual)');
    expect(result).to.include('[Agent] message 1');
    expect(result).to.include('[Agent] message 2');
    expect(result).to.include('(messages 1–2 of 2; end of transcript)');
  });

  it('pages a long transcript and names the exact offset to ask for next [unit]', () => {
    const run = finishedRun(5);

    const first = formatRunTranscript(getThreadStore(), run, 0, 2);
    expect(first).to.include('message 2');
    expect(first).to.not.include('message 3');
    expect(first).to.include('(messages 1–2 of 5; call again with offset=2 for more)');

    const second = formatRunTranscript(getThreadStore(), run, 2, 2);
    expect(second).to.include('message 3');
    expect(second).to.include('(messages 3–4 of 5; call again with offset=4 for more)');
  });

  it('reports an offset past the end instead of returning an empty page [unit]', () => {
    const run = finishedRun(1);
    const result = formatRunTranscript(getThreadStore(), run, 5, 40);
    expect(result).to.include('offset 5 is past the end — this run has 1 messages');
  });

  it('reports no messages recorded for a finished run with an empty thread [unit]', () => {
    const store = getWorkspaceStore();
    const entry = store.enqueueTask(taskId);
    const threadId = `run-thread-${entry.id}`;
    store.setQueueEntryThread(entry.id, threadId);
    getThreadStore().upsertThreadOnFirstMessage(threadId, 'run', 'task');
    store.completeQueueEntry(entry.id, 'done');

    const result = formatRunTranscript(getThreadStore(), store.getTaskRun(entry.id)!, 0, 40);
    expect(result).to.include('(no messages recorded)');
  });
});
