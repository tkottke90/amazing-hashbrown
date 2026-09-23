import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { startTestServer } from '@/tests/utilities/http-test-server.js';
import { workspaceChatRouter } from './workspace-chat.route.js';
import {
  bootWorkspaceStore,
  getWorkspaceStore,
  WorkspaceStore,
  type Workspace,
} from '../../services/workspace-store.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { bootTaskScheduler } from '../../services/task-scheduler.js';
import { recordHitlPrompt } from '../../agents/thread-message-writer.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../../agents/active-sse-writer.js';

// Covers the new POST /:threadId/stop route — see
// docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md. The
// route delegates to active-sse-writer.ts's stopTurnResponse() (already
// exhaustively unit-tested in active-sse-writer.test.ts) plus this file's
// own resolveWorkspaceForThread() gate — this proves both are wired up
// correctly on the actual registered Express route.
describe('routes/v1/workspace-chat.route — POST /:threadId/stop', () => {
  // Mounted with mergeParams under /:id/chat in the real app (see
  // workspaces.route.ts) — replicate that same nesting here so :id reaches
  // resolveWorkspaceForThread the same way it does in production.
  const BASE_PATH = '/api/v1/workspaces/:id/chat';

  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;
  let workspaceStore: WorkspaceStore;
  let workspace: Workspace;
  let threadId: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(workspaceChatRouter, BASE_PATH));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    workspaceStore = new WorkspaceStore(db);
    bootWorkspaceStore(db);

    threadId = 'thread-1';
    workspace = workspaceStore.createWorkspace({ name: 'W', location: '/tmp/w' });
    workspace = workspaceStore.patchWorkspace(workspace.id, { threadId })!;
  });

  afterEach(() => {
    clearActiveSseWriter(threadId);
    rmSync(dir, { recursive: true, force: true });
  });

  function stopUrl(workspaceId: string, tid: string): string {
    return baseUrl.replace(':id', workspaceId) + `/${tid}/stop`;
  }

  it('returns 404 for an unresolvable workspace before ever touching the turn registry', async () => {
    const res = await fetch(stopUrl('no-such-workspace', threadId), { method: 'POST' });
    expect(res.status).to.equal(404);
  });

  it('returns 409 when nothing is active for the thread', async () => {
    const res = await fetch(stopUrl(workspace.id, threadId), { method: 'POST' });
    expect(res.status).to.equal(409);
    expect(await res.json()).to.deep.equal({ error: 'No active turn for this thread' });
  });

  it('returns 409 for a task-owned thread (writer set, no controller)', async () => {
    setActiveSseWriter(threadId, () => {});
    const res = await fetch(stopUrl(workspace.id, threadId), { method: 'POST' });
    expect(res.status).to.equal(409);
  });

  it('returns 202 and aborts the controller for a chat-owned thread', async () => {
    const controller = new AbortController();
    setActiveSseWriter(threadId, () => {}, controller);

    const res = await fetch(stopUrl(workspace.id, threadId), { method: 'POST' });

    expect(res.status).to.equal(202);
    expect(await res.json()).to.deep.equal({ ok: true });
    expect(controller.signal.aborted).to.equal(true);
  });
});

// Orchestration test for the taskId-carrying branch of POST /:threadId/hitl
// (workspace-chat.route.ts:122-199) — previously had zero test coverage.
// Mounted the same way as the POST /:threadId/stop suite above (see
// http-test-server.ts) — a real registered Express route, not a mocked
// req/res. Deliberately scoped to the taskId branch only: the no-taskId
// fallback (resumeWorkspaceChatToSse) needs a real/mocked LLM provider to
// exercise safely over a real HTTP round-trip, which is out of scope here
// and already covered at the unit level by stream-handler.test.ts and
// workspace-chat-stream-handler.test.ts.
describe('routes/v1/workspace-chat.route — POST /:threadId/hitl (taskId branch)', () => {
  const BASE_PATH = '/api/v1/workspaces/:id/chat';

  let baseUrl: string;
  let close: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ baseUrl, close } = await startTestServer(workspaceChatRouter, BASE_PATH));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-hitl-route-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    // No executor registered — wake() dequeues then stops, which is exactly
    // what proves the task was actually re-enqueued rather than just
    // patched in place.
    bootTaskScheduler();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function hitlUrl(workspaceId: string, tid: string): string {
    return baseUrl.replace(':id', workspaceId) + `/${tid}/hitl`;
  }

  it("resumes the task's parked queue row (its original position) with the resume answer, instead of resuming an interactive turn", async () => {
    const store = getWorkspaceStore();
    const threadStore = getThreadStore();

    const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
    const threadId = 'thread-1';
    store.patchWorkspace(workspace.id, { threadId });
    threadStore.upsertThreadOnFirstMessage(threadId, 'W', 'workspace-chat');

    const task = store.createTask({
      title: 'Do the thing',
      assignedTo: 'agent',
      workspaceId: workspace.id,
    });
    store.patchTask(task.id, { status: 'ready' });
    // Mirrors task-execution.ts's interrupt path: the queue row is parked
    // (not closed), which is what this test proves the /hitl route reuses
    // rather than enqueueing a fresh one.
    const parkedEntry = store.enqueueTask(task.id);
    store.parkQueueEntryForHitl(parkedEntry.id);

    const promptId = 'prompt-1';
    recordHitlPrompt(threadStore, threadId, promptId, {
      question: 'Approve command execution?',
      promptKind: 'shell_approval',
      command: 'ls -la',
      taskId: task.id,
    });

    const res = await fetch(hitlUrl(workspace.id, threadId), {
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
    // The SAME row (its original queue position) was reused — not a fresh
    // one appended to the back, which is exactly the starvation bug this
    // fixes (see workspace-store.test.ts's HITL park/resume suite).
    expect(queueEntry!.id).to.equal(parkedEntry.id);

    const promptRow = threadStore.getMessage(threadId, promptId)!;
    expect(promptRow.status).to.equal('answered');
    expect((promptRow.payload as Record<string, unknown>).answer).to.equal('approved');
  });

  it('falls back to enqueueTask() when a HITL-answered task has no parked queue row (defensive)', async () => {
    const store = getWorkspaceStore();
    const threadStore = getThreadStore();

    const workspace = store.createWorkspace({ name: 'W1b', location: '/tmp/w1b' });
    const threadId = 'thread-1b';
    store.patchWorkspace(workspace.id, { threadId });
    threadStore.upsertThreadOnFirstMessage(threadId, 'W1b', 'workspace-chat');

    const task = store.createTask({
      title: 'Do the thing',
      assignedTo: 'user',
      workspaceId: workspace.id,
    });
    store.patchTask(task.id, { status: 'waiting_on_user' });
    // Deliberately no parked queue row — the invariant parkQueueEntryForHitl()
    // normally guarantees is violated here on purpose.

    const promptId = 'prompt-1b';
    recordHitlPrompt(threadStore, threadId, promptId, {
      question: 'Approve command execution?',
      promptKind: 'shell_approval',
      command: 'ls -la',
      taskId: task.id,
    });

    const res = await fetch(hitlUrl(workspace.id, threadId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId, answer: 'approved' }),
    });
    expect(res.status).to.equal(200);
    await res.text();

    const queueEntry = store.listQueue().find((q) => q.taskId === task.id);
    expect(queueEntry, 'expected a fresh queue row via the fallback').to.not.equal(undefined);
    expect(queueEntry!.status).to.equal('running');
  });

  // Regression: an orphaned hitl_prompt (see task-execution.test.ts's own
  // regression case — finalizeTurn can dispatch one for a task whose run
  // already completed via complete_task in the same stream) has no parked
  // queue row behind it, same as the defensive-fallback case above. But
  // unlike that case, the task here is genuinely finished (status 'done'),
  // not actually waiting on this answer at all. The "no parked row -> enqueue
  // fresh" fallback used to fire for this too, silently re-running an
  // already-completed task from scratch — exactly the bug the manual test
  // run surfaced (a task correctly marked done, then clobbered back to
  // failed by a duplicate run triggered off this exact stale prompt).
  it('does not re-enqueue an already-finished task when a stale/orphaned hitl_prompt is answered', async () => {
    const store = getWorkspaceStore();
    const threadStore = getThreadStore();

    const workspace = store.createWorkspace({ name: 'W1c', location: '/tmp/w1c' });
    const threadId = 'thread-1c';
    store.patchWorkspace(workspace.id, { threadId });
    threadStore.upsertThreadOnFirstMessage(threadId, 'W1c', 'workspace-chat');

    const task = store.createTask({
      title: 'Do the thing',
      assignedTo: 'agent',
      workspaceId: workspace.id,
    });
    store.patchTask(task.id, { status: 'ready' });
    const entry = store.enqueueTask(task.id);
    store.completeQueueEntry(entry.id, 'done');
    // Task is genuinely finished — no parked row, and never will be one.
    expect(store.getTask(task.id)!.status).to.equal('done');

    const promptId = 'prompt-1c';
    recordHitlPrompt(threadStore, threadId, promptId, {
      question: 'Approve command execution?',
      promptKind: 'shell_approval',
      command: 'ls -la',
      taskId: task.id,
    });

    const res = await fetch(hitlUrl(workspace.id, threadId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId, answer: 'approved' }),
    });
    expect(res.status).to.equal(200);
    await res.text();

    const updatedTask = store.getTask(task.id)!;
    expect(updatedTask.status, 'a finished task must not be reopened by a stale answer').to.equal(
      'done',
    );
    const queueEntry = store.listQueue().find((q) => q.taskId === task.id);
    expect(queueEntry, 'no fresh queue row should ever be created for a finished task').to.equal(
      undefined,
    );
  });

  it('rejects with 400 when promptId or answer is missing, without touching any task', async () => {
    const store = getWorkspaceStore();
    const workspace = store.createWorkspace({ name: 'W2', location: '/tmp/w2' });
    const threadId = 'thread-2';
    store.patchWorkspace(workspace.id, { threadId });

    const res = await fetch(hitlUrl(workspace.id, threadId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).to.equal(400);
  });

  it('404s when the workspace does not exist', async () => {
    const res = await fetch(hitlUrl('does-not-exist', 'thread-x'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promptId: 'p', answer: 'a' }),
    });
    expect(res.status).to.equal(404);
  });
});
