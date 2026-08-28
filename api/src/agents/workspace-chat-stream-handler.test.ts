import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { bootThreadStore } from '../services/thread-store.js';
import {
  WorkspaceStore,
  bootWorkspaceStore,
  type Workspace,
} from '../services/workspace-store.js';
import { bootTaskScheduler, type TaskScheduler } from '../services/task-scheduler.js';
import { setActiveSseWriter, clearActiveSseWriter } from './active-sse-writer.js';
import {
  streamWorkspaceChatToSse,
  resumeWorkspaceChatToSse,
  retryWorkspaceChatToSse,
} from './workspace-chat-stream-handler.js';

// A minimal fake Express Response — these functions call res.write() only
// via the sink they build internally.
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: (): ChatSSEEvent[] =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as ChatSSEEvent),
  };
}

// Issue #87's concurrency guard: an automated task run registers itself in
// the same active-sse-writer slot a live chat turn would, for the exact
// duration of its run — these three entry points must reject rather than
// race a second agent.streamEvents() invocation against the same LangGraph
// checkpoint. This suite only exercises that early-return guard (it fires
// before any agent/provider is touched); the full streaming happy path
// needs a real or stubbed LLM provider and isn't in scope here.
describe('agents/workspace-chat-stream-handler — concurrency guard', () => {
  let dir: string;
  let workspaceStore: WorkspaceStore;
  let workspace: Workspace;
  let threadId: string;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-stream-guard-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    workspaceStore = new WorkspaceStore(db);
    bootWorkspaceStore(db);
    bootThreadStore(db);
    scheduler = bootTaskScheduler();

    threadId = randomUUID();
    workspace = workspaceStore.createWorkspace({ name: 'W', location: '/tmp/w' });
    workspace = workspaceStore.patchWorkspace(workspace.id, { threadId })!;

    // Simulates an automated task run currently owning this thread.
    setActiveSseWriter(threadId, () => {});
  });

  afterEach(() => {
    // Each guarded call still arms scheduleResume()'s idle timer in its
    // finally block — stop() clears it so the timer doesn't outlive this
    // test (and the temp DB it would otherwise fire against later).
    scheduler.stop();
    clearActiveSseWriter(threadId);
    rmSync(dir, { recursive: true, force: true });
  });

  it('streamWorkspaceChatToSse rejects with stream_error when the thread is busy', async () => {
    const { res, events } = fakeRes();
    await streamWorkspaceChatToSse(res, workspace, threadId, 'hello', Date.now());

    const emitted = events();
    expect(emitted).to.have.length(1);
    expect(emitted[0]!.type).to.equal('stream_error');
  });

  it('resumeWorkspaceChatToSse rejects with stream_error when the thread is busy', async () => {
    const { res, events } = fakeRes();
    await resumeWorkspaceChatToSse(res, workspace, threadId, 'prompt-1', 'yes', Date.now());

    const emitted = events();
    expect(emitted).to.have.length(1);
    expect(emitted[0]!.type).to.equal('stream_error');
  });

  it('retryWorkspaceChatToSse rejects with stream_error when the thread is busy', async () => {
    const { res, events } = fakeRes();
    await retryWorkspaceChatToSse(res, workspace, threadId, Date.now());

    const emitted = events();
    expect(emitted).to.have.length(1);
    expect(emitted[0]!.type).to.equal('stream_error');
  });
});
