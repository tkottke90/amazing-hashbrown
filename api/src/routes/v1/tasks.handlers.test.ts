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
  createTaskHandler,
  patchTaskHandler,
  enqueueTaskHandler,
  cancelTaskHandler,
  pauseTaskHandler,
  takeOverTaskHandler,
  generatePlanForNewTaskHandler,
  generatePlanForTaskHandler,
} from './tasks.handlers.js';
import {
  registerTaskAbort,
  getTaskAbort,
  clearTaskAbort,
} from '../../agents/active-task-abort.js';

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

    it('generates a webhook token when patching triggerType to webhook', () => {
      const task = store.createTask({ title: 'Do the thing' });
      const result = patchTaskHandler(store, task.id, { triggerType: 'webhook' });

      expect(result.ok).to.equal(true);
      if (result.ok) {
        const config = result.data!.triggerConfig as { webhookToken?: string } | null;
        expect(config?.webhookToken).to.be.a('string').with.length.greaterThan(0);
      }
    });

    it('replaces the token when regenerateWebhookToken is true', () => {
      const task = store.createTask({ title: 'Do the thing' });
      const first = patchTaskHandler(store, task.id, { triggerType: 'webhook' });
      const tokenA = (
        first.ok ? (first.data!.triggerConfig as { webhookToken?: string } | null) : null
      )?.webhookToken;

      const second = patchTaskHandler(store, task.id, { regenerateWebhookToken: true });
      const tokenB = (
        second.ok ? (second.data!.triggerConfig as { webhookToken?: string } | null) : null
      )?.webhookToken;

      expect(tokenB).to.be.a('string').with.length.greaterThan(0);
      expect(tokenB).to.not.equal(tokenA);
    });

    it('is a no-op when regenerateWebhookToken is true on a non-webhook task', () => {
      const task = store.createTask({ title: 'Do the thing' });
      const result = patchTaskHandler(store, task.id, { regenerateWebhookToken: true });

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.triggerConfig).to.equal(null);
    });

    it('discards a client-supplied triggerConfig.webhookToken on patch', () => {
      const task = store.createTask({ title: 'Do the thing' });
      const first = patchTaskHandler(store, task.id, { triggerType: 'webhook' });
      const tokenA = (
        first.ok ? (first.data!.triggerConfig as { webhookToken?: string } | null) : null
      )?.webhookToken;

      const second = patchTaskHandler(store, task.id, {
        triggerConfig: { webhookToken: 'client-supplied' },
      });
      const tokenB = (
        second.ok ? (second.data!.triggerConfig as { webhookToken?: string } | null) : null
      )?.webhookToken;

      expect(tokenB).to.equal(tokenA);
      expect(tokenB).to.not.equal('client-supplied');
    });
  });

  describe('createTaskHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-create-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a missing title', () => {
      const result = createTaskHandler(store, {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('generates a webhook token when creating a task with triggerType webhook', () => {
      const result = createTaskHandler(store, { title: 'Do the thing', triggerType: 'webhook' });

      expect(result.ok).to.equal(true);
      if (result.ok) {
        const config = result.data!.triggerConfig as { webhookToken?: string } | null;
        expect(config?.webhookToken).to.be.a('string').with.length.greaterThan(0);
      }
    });

    it('discards a client-supplied triggerConfig.webhookToken on create', () => {
      const result = createTaskHandler(store, {
        title: 'Do the thing',
        triggerType: 'webhook',
        triggerConfig: { webhookToken: 'client-supplied' },
      });

      expect(result.ok).to.equal(true);
      if (result.ok) {
        const config = result.data!.triggerConfig as { webhookToken?: string } | null;
        expect(config?.webhookToken).to.not.equal('client-supplied');
      }
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

  describe('patchTaskHandler() — reassignment guard', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-reassign-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('400s reassigning a ready task away from the agent', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.patchTask(task.id, { status: 'ready' });

      const result = patchTaskHandler(store, task.id, { assignedTo: 'user' });

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
      expect(store.getTask(task.id)!.assignedTo).to.equal('agent');
    });

    it('400s reassigning a running task away from the agent', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      store.dequeueNext();

      const result = patchTaskHandler(store, task.id, { assignedTo: null });

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('allows a patch that resends the same assignedTo on a running task (Save re-sending unchanged fields)', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      store.dequeueNext();

      const result = patchTaskHandler(store, task.id, {
        assignedTo: 'agent',
        status: 'running',
        title: 'still t',
      });

      expect(result.ok).to.equal(true);
    });

    it('allows reassignment away from the agent on a task that is not ready/running', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });

      const result = patchTaskHandler(store, task.id, { assignedTo: 'user' });

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.assignedTo).to.equal('user');
    });
  });

  describe('patchTaskHandler() — resume special case', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-resume-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reuses the existing paused queue row rather than enqueuing a new one', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      const entry = store.dequeueNext()!;
      store.parkQueueEntry(entry.id); // status: 'blocked', queue row: 'paused'

      const result = patchTaskHandler(store, task.id, { status: 'ready' });

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.status).to.equal('ready');
      const rows = store.listQueue().filter((e) => e.taskId === task.id);
      expect(rows).to.have.length(1);
      expect(rows[0]!.id).to.equal(entry.id);
      expect(rows[0]!.status).to.equal('pending');
    });
  });

  describe('cancelTaskHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-cancel-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function makeReadyTask() {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      store.patchTask(task.id, { status: 'ready' });
      return task;
    }

    function makeRunningTask() {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      const entry = store.dequeueNext()!;
      return { task, entry };
    }

    it('cancels a ready task synchronously', () => {
      const task = makeReadyTask();
      const result = cancelTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.status).to.equal('cancelled');
      expect(store.listQueue().find((e) => e.taskId === task.id)).to.equal(undefined);
    });

    it('aborts a running task with a registered abort entry, leaving status "running" in the response', () => {
      const { task, entry } = makeRunningTask();
      const controller = registerTaskAbort(entry.id);

      const result = cancelTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.status).to.equal('running'); // lands asynchronously
      expect(getTaskAbort(entry.id)!.intent).to.equal('cancel');
      expect(controller.signal.aborted).to.equal(true);
      clearTaskAbort(entry.id);
    });

    it('409s a running task with no registered abort entry (e.g. the e2e noop executor)', () => {
      const { task } = makeRunningTask();
      const result = cancelTaskHandler(store, task.id);

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });

    it('409s for a task that is done/failed/pending/blocked', () => {
      for (const status of ['done', 'failed', 'pending', 'blocked'] as const) {
        const task = store.createTask({ title: 't', assignedTo: 'agent' });
        store.patchTask(task.id, { status });
        const result = cancelTaskHandler(store, task.id);
        expect(result.ok, `expected ${status} to 409`).to.equal(false);
        if (!result.ok) expect(result.status).to.equal(409);
      }
    });

    it('404s for a nonexistent task', () => {
      const result = cancelTaskHandler(store, 'does-not-exist');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('pauseTaskHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-pause-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function makeRunningTask() {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      const entry = store.dequeueNext()!;
      return { task, entry };
    }

    it('aborts a running task, leaving status "running" in the response', () => {
      const { task, entry } = makeRunningTask();
      const controller = registerTaskAbort(entry.id);

      const result = pauseTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data!.status).to.equal('running'); // 'blocked' lands asynchronously
      expect(getTaskAbort(entry.id)!.intent).to.equal('pause');
      expect(controller.signal.aborted).to.equal(true);
      clearTaskAbort(entry.id);
    });

    it('409s when running but no abort entry is registered', () => {
      const { task } = makeRunningTask();
      const result = pauseTaskHandler(store, task.id);

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });

    it('409s a ready task (nothing running yet to pause)', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);

      const result = pauseTaskHandler(store, task.id);

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });

    it('404s for a nonexistent task', () => {
      const result = pauseTaskHandler(store, 'does-not-exist');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('takeOverTaskHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'tasks-handlers-take-over-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reassigns a ready task synchronously and retires its queue row', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      const entry = store.enqueueTask(task.id);
      store.patchTask(task.id, { status: 'ready' });

      const result = takeOverTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data!.status).to.equal('pending');
        expect(result.data!.assignedTo).to.equal('user');
      }
      expect(store.listQueue().find((e) => e.id === entry.id)).to.equal(undefined);
    });

    it('reassigns a running task synchronously regardless of abort outcome, and aborts the live run', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      const entry = store.dequeueNext()!;
      const controller = registerTaskAbort(entry.id);

      const result = takeOverTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data!.status).to.equal('pending');
        expect(result.data!.assignedTo).to.equal('user');
      }
      expect(getTaskAbort(entry.id)!.intent).to.equal('take-over');
      expect(controller.signal.aborted).to.equal(true);
      clearTaskAbort(entry.id);
    });

    it('reassigns a running task even with no registered abort entry, detaching the queue row directly', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      const entry = store.dequeueNext()!;

      const result = takeOverTaskHandler(store, task.id);

      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data!.status).to.equal('pending');
        expect(result.data!.assignedTo).to.equal('user');
      }
      expect(store.listQueue().find((e) => e.id === entry.id)).to.equal(undefined);
    });

    it('409s for a task that is done/failed/blocked', () => {
      for (const status of ['done', 'failed', 'blocked'] as const) {
        const task = store.createTask({ title: 't', assignedTo: 'agent' });
        store.patchTask(task.id, { status });
        const result = takeOverTaskHandler(store, task.id);
        expect(result.ok, `expected ${status} to 409`).to.equal(false);
        if (!result.ok) expect(result.status).to.equal(409);
      }
    });

    it('404s for a nonexistent task', () => {
      const result = takeOverTaskHandler(store, 'does-not-exist');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
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
