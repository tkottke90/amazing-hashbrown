import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { patchTaskHandler, enqueueTaskHandler } from './tasks.handlers.js';

describe('routes/v1/tasks.handlers', () => {
  describe('patchTaskHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('enqueues an agent-assigned task when status is patched to ready', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'agent' });
      const result = patchTaskHandler(store, task.id, { status: 'ready' });

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.status).to.equal('ready');
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
    });

    it('does not enqueue a user-assigned task patched to ready', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'user' });
      const result = patchTaskHandler(store, task.id, { status: 'ready' });

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.status).to.equal('ready');
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(0);
    });

    it('does not enqueue a task with no assignedTo patched to ready', () => {
      const task = store.createTask({ title: 'Do the thing' });
      patchTaskHandler(store, task.id, { status: 'ready' });

      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(0);
    });

    it('does not double-enqueue on a second patch to ready', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'agent' });
      patchTaskHandler(store, task.id, { status: 'ready' });
      patchTaskHandler(store, task.id, { status: 'ready' });

      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
    });

    it('enqueues on reassignment to agent after status was already set to ready', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'user' });
      patchTaskHandler(store, task.id, { status: 'ready' });
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(0);

      patchTaskHandler(store, task.id, { assignedTo: 'agent' });
      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
    });

    it('never enqueues when status is patched to something other than ready', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'agent' });
      patchTaskHandler(store, task.id, { status: 'running' });

      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(0);
    });

    it('returns 404 for a nonexistent task', () => {
      const result = patchTaskHandler(store, 'does-not-exist', { status: 'ready' });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('enqueueTaskHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-enqueue-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('sets tasks.status to ready when enqueuing a pending task directly', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'agent' });
      expect(task.status).to.equal('pending');

      const result = enqueueTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      expect(store.getTask(task.id)!.status).to.equal('ready');
    });

    it('does not create a second queue entry if a subsequent PATCH sets status to ready', () => {
      const task = store.createTask({ title: 'Do the thing', assignedTo: 'agent' });
      enqueueTaskHandler(store, task.id);
      patchTaskHandler(store, task.id, { status: 'ready' });

      expect(store.listQueue().filter((e) => e.taskId === task.id)).to.have.length(1);
    });
  });
});
