import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { bootObservability } from '../../services/observability.js';
import {
  patchTaskHandler,
  enqueueTaskHandler,
  generatePlanForNewTaskHandler,
  generatePlanForTaskHandler,
} from './tasks.handlers.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

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

  describe('generatePlanForNewTaskHandler() / generatePlanForTaskHandler()', () => {
    let obsDir: string;
    let store: WorkspaceStore;
    let dir: string;

    before(() => {
      obsDir = mkdtempSync(join(tmpdir(), 'tasks-handlers-generate-plan-obs-'));
      bootObservability(openDatabase(join(obsDir, 'observability.db')));
    });
    after(() => {
      rmSync(obsDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-generate-plan-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a missing title', async () => {
      const model = new FakeListChatModel({ responses: ['[]'] });
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('rejects an empty/whitespace title', async () => {
      const model = new FakeListChatModel({ responses: ['[]'] });
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: '   ',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('generates a plan for an unsaved task with no workspace_id (Path B)', async () => {
      const model = new FakeListChatModel({
        responses: ['[{"step": "Write the docs", "done": false}]'],
      });
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: 'Document the API',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal([{ step: 'Write the docs', done: false }]);
      }
    });

    it('generates a plan for an unsaved task in a workspace with no wikiId (Path A)', async () => {
      const workspace = store.createWorkspace({
        name: 'Widget Factory',
        goal: 'Ship v2',
        location: join(dir, 'nonexistent-location'),
      });
      const model = new FakeListChatModel({
        responses: ['[{"step": "Plan v2", "done": false}]'],
      });
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: 'Kick off v2',
        workspaceId: workspace.id,
      });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal([{ step: 'Plan v2', done: false }]);
      }
    });

    it('degrades gracefully to a bare prompt when workspace_id does not resolve', async () => {
      const model = new FakeListChatModel({ responses: ['[]'] });
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: 'Kick off v2',
        workspaceId: 'does-not-exist',
      });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([]);
    });

    it('returns 500 when the model throws', async () => {
      const model = new ThrowingChatModel({});
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: 'Kick off v2',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(500);
    });

    it('returns 500 when the model response is not parseable plan JSON', async () => {
      const model = new FakeListChatModel({ responses: ['sure, here is a plan for you'] });
      const result = await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: 'Kick off v2',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(500);
        expect(result.error).to.include('unparseable');
      }
    });

    it('includes the workspace name in the Path A prompt sent to the model', async () => {
      const workspace = store.createWorkspace({
        name: 'Widget Factory',
        goal: 'Ship v2',
        location: join(dir, 'nonexistent-location'),
      });

      let capturedPrompt = '';
      class CapturingModel extends FakeListChatModel {
        override async invoke(input: unknown, options?: unknown) {
          capturedPrompt = String(input);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return super.invoke(input as any, options as any);
        }
      }
      const model = new CapturingModel({ responses: ['[]'] });

      await generatePlanForNewTaskHandler(store, model, undefined, undefined, {
        title: 'Kick off v2',
        workspaceId: workspace.id,
      });

      expect(capturedPrompt).to.include('Widget Factory');
      expect(capturedPrompt).to.include('Ship v2');
    });

    it('returns 404 for a nonexistent task id', async () => {
      const model = new FakeListChatModel({ responses: ['[]'] });
      const result = await generatePlanForTaskHandler(
        store,
        model,
        undefined,
        undefined,
        'does-not-exist',
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('generates a plan for a saved task, pulling title/description off the stored task', async () => {
      const task = store.createTask({ title: 'Migrate the database', description: 'To Postgres' });
      const model = new FakeListChatModel({
        responses: ['[{"step": "Write migration scripts", "done": false}]'],
      });
      const result = await generatePlanForTaskHandler(store, model, undefined, undefined, task.id);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal([{ step: 'Write migration scripts', done: false }]);
      }
    });
  });
});
