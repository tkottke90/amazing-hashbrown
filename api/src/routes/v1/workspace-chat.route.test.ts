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
  WorkspaceStore,
  type Workspace,
} from '../../services/workspace-store.js';
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
