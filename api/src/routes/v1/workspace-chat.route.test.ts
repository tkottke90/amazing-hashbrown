import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootTaskScheduler } from '../../services/task-scheduler.js';
import { recordHitlPrompt } from '../../agents/thread-message-writer.js';
import { createApp } from '../../app.js';

// Orchestration test for the taskId-carrying branch of POST /:threadId/hitl
// (workspace-chat.route.ts:122-199) — previously had zero test coverage.
// Exercises the real request -> middleware -> handler -> response pipeline
// via a real Express app on an ephemeral loopback port (this repo has no
// supertest dependency installed, so a real listener + the built-in fetch()
// stands in for it). Deliberately scoped to the taskId branch only: the
// no-taskId fallback (resumeWorkspaceChatToSse) needs a real/mocked LLM
// provider to exercise safely over a real HTTP round-trip, which is out of
// scope here and already covered at the unit level by stream-handler.test.ts
// and workspace-chat-stream-handler.test.ts.
describe('routes/v1/workspace-chat.route POST /:threadId/hitl (taskId branch)', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-hitl-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    // No executor registered — wake() dequeues then stops, which is exactly
    // what proves the task was actually re-enqueued rather than just
    // patched in place.
    bootTaskScheduler();

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-enqueues the task with the resume answer instead of resuming an interactive turn', async () => {
    const store = getWorkspaceStore();
    const threadStore = getThreadStore();

    const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
    const threadId = 'thread-1';
    store.patchWorkspace(workspace.id, { threadId });
    threadStore.upsertThreadOnFirstMessage(threadId, 'W', 'workspace-chat');

    const task = store.createTask({
      title: 'Do the thing',
      assignedTo: 'user',
      workspaceId: workspace.id,
    });
    store.patchTask(task.id, { status: 'waiting_on_user' });

    const promptId = 'prompt-1';
    recordHitlPrompt(threadStore, threadId, promptId, {
      question: 'Approve command execution?',
      promptKind: 'shell_approval',
      command: 'ls -la',
      taskId: task.id,
    });

    const res = await fetch(`${baseUrl}/api/v1/workspaces/${workspace.id}/chat/${threadId}/hitl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId, answer: 'approved' }),
    });
    expect(res.status).to.equal(200);
    // Drain the full SSE body — the handler's own `finally { res.end() }`
    // only runs after the task/queue/prompt mutations below, so waiting for
    // the response to fully close guarantees those mutations already
    // happened, rather than racing the client's view of the response
    // against the server's still-in-flight handler.
    await res.text();

    // wake() -> tick() -> dequeueNext() runs synchronously and claims the
    // queue entry (status: 'running') *before* tick() ever checks whether an
    // executor is registered — with none registered here, that claim is as
    // far as it gets. So "running", not "ready", is the actual proof the
    // task was really re-enqueued and picked up by the scheduler, not just
    // patched in place.
    const updatedTask = store.getTask(task.id)!;
    expect(updatedTask.status).to.equal('running');
    expect(updatedTask.assignedTo).to.equal('agent');
    expect(updatedTask.resumeAnswer).to.equal('approved');

    const queueEntry = store.listQueue().find((q) => q.taskId === task.id);
    expect(queueEntry, 'expected the task to be re-enqueued').to.not.equal(undefined);
    expect(queueEntry!.status).to.equal('running');

    const promptRow = threadStore.getMessage(threadId, promptId)!;
    expect(promptRow.status).to.equal('answered');
    expect((promptRow.payload as Record<string, unknown>).answer).to.equal('approved');
  });

  it('rejects with 400 when promptId or answer is missing, without touching any task', async () => {
    const store = getWorkspaceStore();
    const workspace = store.createWorkspace({ name: 'W2', location: '/tmp/w2' });
    const threadId = 'thread-2';
    store.patchWorkspace(workspace.id, { threadId });

    const res = await fetch(`${baseUrl}/api/v1/workspaces/${workspace.id}/chat/${threadId}/hitl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).to.equal(400);
  });

  it('404s when the workspace does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/v1/workspaces/does-not-exist/chat/thread-x/hitl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId: 'p', answer: 'a' }),
    });
    expect(res.status).to.equal(404);
  });
});
