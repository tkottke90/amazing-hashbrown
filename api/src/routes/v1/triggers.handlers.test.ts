import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { triggerWebhookHandler } from './triggers.handlers.js';

describe('routes/v1/triggers.handlers', () => {
  describe('triggerWebhookHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'triggers-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 404 for a token that matches no task', () => {
      const result = triggerWebhookHandler(store, 'nonexistent-token');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('enqueues the matching task and returns the queue entry', () => {
      const task = store.createTask({
        title: 'Ping me',
        assignedTo: 'agent',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'known-test-token' },
      });

      const result = triggerWebhookHandler(store, 'known-test-token');

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.taskId).to.equal(task.id);
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
      expect(store.getTask(task.id)!.status).to.equal('ready');
    });

    it('returns 409 when the task is already queued', () => {
      const task = store.createTask({
        title: 'Ping me',
        assignedTo: 'agent',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'known-test-token' },
      });
      store.enqueueTask(task.id);

      const result = triggerWebhookHandler(store, 'known-test-token');

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
    });

    it('returns 409 when the task is already running', () => {
      const task = store.createTask({
        title: 'Ping me',
        assignedTo: 'agent',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'known-test-token' },
      });
      store.enqueueTask(task.id);
      store.dequeueNext();

      const result = triggerWebhookHandler(store, 'known-test-token');

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });
  });
});
