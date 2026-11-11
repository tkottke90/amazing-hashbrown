import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore, type Task } from '../services/workspace-store.js';
import { buildNotificationMessage } from './sub-agent-notification.js';

describe('agents/sub-agent-notification: buildNotificationMessage', () => {
  let dir: string;
  let task: Task;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sub-agent-notification-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    const store = getWorkspaceStore();
    const workspaceId = store.createWorkspace({ name: 'W', location: '/tmp/ws' }).id;
    task = store.createSubAgentTask({
      role: 'researcher',
      goal: 'Find something',
      parentThreadId: 'parent-thread-1',
      dispatchGroupId: 'group-1',
      workspaceId,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes a Thread line pointing at search_threads when a runThreadId is given', () => {
    const message = buildNotificationMessage(task, 'done', 'All done.', 0, 'run-thread-abc');
    expect(message).to.include('Thread: `run-thread-abc` (use search_threads to look into it)');
  });

  it('omits the Thread line entirely when no runThreadId is given', () => {
    const message = buildNotificationMessage(task, 'done', 'All done.', 0, undefined);
    expect(message).to.not.include('Thread:');
  });

  it('still reports outcome and summary normally regardless of the Thread line', () => {
    const message = buildNotificationMessage(task, 'failed', 'Hit an error.', 2, 'run-thread-xyz');
    expect(message).to.include('failed — goal: "Find something".');
    expect(message).to.include('Summary: Hit an error.');
    expect(message).to.include('2 sibling sub-agent(s) from this dispatch are still running.');
    expect(message).to.include('Thread: `run-thread-xyz`');
  });
});
