import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { createWebhookTaskHandler } from './webhooks.handlers.js';

describe('routes/v1/webhooks.handlers — createWebhookTaskHandler()', () => {
  let store: WorkspaceStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webhooks-handlers-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function isQueued(taskId: string): boolean {
    return store.listQueue().some((entry) => entry.taskId === taskId);
  }

  it('rejects a request with no title', () => {
    const result = createWebhookTaskHandler(store, null, {}, undefined);
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(400);
  });

  it('rejects an unknown x-workspace-id', () => {
    const result = createWebhookTaskHandler(store, null, { title: 't' }, 'does-not-exist');
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(400);
  });

  it('rejects a status value other than pending/ready', () => {
    const result = createWebhookTaskHandler(store, null, { title: 't', status: 'done' }, undefined);
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(400);
  });

  it('rejects an assignedTo value other than user/agent', () => {
    const result = createWebhookTaskHandler(
      store,
      null,
      { title: 't', assignedTo: 'nobody' },
      undefined,
    );
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(400);
  });

  it('defaults assignedTo to "user" when omitted, and never auto-queues', () => {
    const result = createWebhookTaskHandler(store, null, { title: 't' }, undefined);

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.assignedTo).to.equal('user');
    expect(result.data.status).to.equal('pending');
    expect(isQueued(result.data.id)).to.equal(false);
  });

  it('every created task carries triggerSource "webhook" and origin "user"', () => {
    const result = createWebhookTaskHandler(store, null, { title: 't' }, undefined);

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.triggerSource).to.equal('webhook');
    expect(result.data.origin).to.equal('user');
  });

  it('patches to ready and enqueues when assignedTo=agent, status=ready, and a valid workspace is given', () => {
    const workspace = store.createWorkspace({ name: 'ws', location: '/tmp/ws' });

    const result = createWebhookTaskHandler(
      store,
      null,
      { title: 't', assignedTo: 'agent', status: 'ready' },
      workspace.id,
    );

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.status).to.equal('ready');
    expect(result.data.assignedTo).to.equal('agent');
    expect(isQueued(result.data.id)).to.equal(true);
    const entry = store.listQueue().find((e) => e.taskId === result.data.id);
    expect(entry?.triggerSource).to.equal('webhook');
  });

  it('stays pending and never queues when status=ready is requested without explicit assignedTo=agent', () => {
    const workspace = store.createWorkspace({ name: 'ws', location: '/tmp/ws' });

    const result = createWebhookTaskHandler(
      store,
      null,
      { title: 't', status: 'ready' },
      workspace.id,
    );

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.status).to.equal('pending');
    expect(result.data.assignedTo).to.equal('user');
    expect(isQueued(result.data.id)).to.equal(false);
  });

  // The core hardening rule from #252: a global API key's blast radius is
  // bounded by requiring an explicit workspace before anything can
  // auto-run. This must never regress.
  it('stays pending in the Inbox and never queues even when agent+ready is requested with no workspace', () => {
    const result = createWebhookTaskHandler(
      store,
      null,
      { title: 't', assignedTo: 'agent', status: 'ready' },
      undefined,
    );

    expect(result.ok).to.equal(true);
    if (!result.ok) return;
    expect(result.data.workspaceId).to.equal(null);
    expect(result.data.status).to.equal('pending');
    expect(isQueued(result.data.id)).to.equal(false);
  });
});
