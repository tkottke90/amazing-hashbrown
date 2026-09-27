import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { chatRouter } from './chat.route.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../../agents/active-sse-writer.js';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { bootTaskScheduler } from '../../services/task-scheduler.js';
import { recordHitlPrompt } from '../../agents/thread-message-writer.js';

// Covers the new POST /:threadId/stop route — see
// docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md. The
// route itself is thin wiring around active-sse-writer.ts's
// stopTurnResponse(), which already has exhaustive unit coverage in
// active-sse-writer.test.ts; this proves the actual registered Express
// route delegates to it correctly (right path, right param, right status).
describe('routes/v1/chat.route — POST /:threadId/stop', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let threadId: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(chatRouter, '/api/v1/chat'));
  });

  after(async () => {
    await close();
  });

  afterEach(() => {
    clearActiveSseWriter(threadId);
  });

  it('returns 409 when nothing is active for the thread', async () => {
    threadId = randomUUID();
    const res = await fetch(`${baseUrl}/${threadId}/stop`, { method: 'POST' });
    expect(res.status).to.equal(409);
    expect(await res.json()).to.deep.equal({ error: 'No active turn for this thread' });
  });

  it('returns 409 for a task-owned thread (writer set, no controller)', async () => {
    threadId = randomUUID();
    setActiveSseWriter(threadId, () => {});
    const res = await fetch(`${baseUrl}/${threadId}/stop`, { method: 'POST' });
    expect(res.status).to.equal(409);
  });

  it('returns 202 and aborts the controller for a chat-owned thread', async () => {
    threadId = randomUUID();
    const controller = new AbortController();
    setActiveSseWriter(threadId, () => {}, controller);

    const res = await fetch(`${baseUrl}/${threadId}/stop`, { method: 'POST' });

    expect(res.status).to.equal(202);
    expect(await res.json()).to.deep.equal({ ok: true });
    expect(controller.signal.aborted).to.equal(true);
  });
});

// Covers the task-run half of the chat routes — see
// docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §4. An
// Inbox task run's thread is a type='task' thread opened in the normal chat
// view: its prompts must re-queue the task (the bug: they used to resume the
// thread as an interactive chat turn, bypassing the scheduler and leaving
// the task stuck at waiting_on_user), and nothing else may write to it.
describe('routes/v1/chat.route — automated task run threads', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(chatRouter, '/api/v1/chat'));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-route-task-thread-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    // No executor — wake() claims the re-queued row ('running') and stops,
    // which is the proof it really went back through the scheduler.
    bootTaskScheduler();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runThread(): string {
    const threadId = randomUUID();
    getThreadStore().upsertThreadOnFirstMessage(threadId, 'Run #1', 'task');
    return threadId;
  }

  it('re-queues an Inbox task when its prompt is answered from the run thread [orchestration]', async () => {
    const store = getWorkspaceStore();
    const threadId = runThread();
    const task = store.createTask({ title: 'Inbox task', assignedTo: 'agent' });
    store.patchTask(task.id, { status: 'ready' });
    const parked = store.enqueueTask(task.id);
    store.setQueueEntryThread(parked.id, threadId);
    store.parkQueueEntryForHitl(parked.id);
    recordHitlPrompt(getThreadStore(), threadId, 'prompt-1', {
      question: 'Which folder?',
      promptKind: 'free_text',
      taskId: task.id,
    });

    const res = await fetch(`${baseUrl}/${threadId}/hitl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId: 'prompt-1', answer: 'docs/' }),
    });
    expect(res.status).to.equal(200);
    await res.text();

    const updated = store.getTask(task.id)!;
    expect(updated.status, 'the scheduler picked the task back up').to.equal('running');
    expect(updated.resumeAnswer).to.equal('docs/');
    expect(store.listQueue().find((q) => q.taskId === task.id)!.id).to.equal(parked.id);
    expect(getThreadStore().getMessage(threadId, 'prompt-1')!.status).to.equal('answered');
  });

  it('rejects a chat message into a run thread with 409 [orchestration]', async () => {
    const res = await fetch(`${baseUrl}/${runThread()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello?' }),
    });
    expect(res.status).to.equal(409);
    expect(await res.json()).to.deep.equal({ error: 'Automated run threads are read-only' });
  });

  it('rejects a retry in a run thread with 409 [orchestration]', async () => {
    const res = await fetch(`${baseUrl}/${runThread()}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).to.equal(409);
  });
});
