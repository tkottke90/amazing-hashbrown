import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootTaskScheduler } from '../../services/task-scheduler.js';
import { TrackerRegistry } from '../../services/tracker-registry.js';
import type { TrackerAdapter } from '../../services/tracker-adapter.js';
import { makeCreateTasksTool } from './create-tasks.tool.js';

function fakeAdapter(type: string, overrides: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    type,
    displayName: type,
    icon: '<svg></svg>',
    authSchema: [],
    canCreate: false,
    resolveUrl: async () => {
      throw new Error('not implemented');
    },
    getItem: async () => {
      throw new Error('not implemented');
    },
    createItem: async () => {
      throw new Error('not implemented');
    },
    updateState: async () => {
      throw new Error('not implemented');
    },
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(workspaceId?: string): any {
  return {
    configurable: { thread_id: 'calling-thread', workspaceId },
    toolCallId: 'call-1',
  };
}

describe('agents/tools/create-tasks', () => {
  let dir: string;
  let workspaceId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'create-tasks-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    // No executor registered — wake()/tick() dequeues then stops, proving
    // the batch actually enqueued rather than just writing 'pending' rows.
    bootTaskScheduler();
    const workspace = getWorkspaceStore().createWorkspace({
      name: 'Test Workspace',
      location: '/tmp/test-workspace',
    });
    workspaceId = workspace.id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects when no workspace is active, without creating any task', async () => {
    const result = await makeCreateTasksTool().invoke(
      { tasks: [{ title: 'a' }] },
      invokeConfig(undefined),
    );
    expect(String(result)).to.include('no active workspace');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('rejects an empty batch', async () => {
    const result = await makeCreateTasksTool().invoke({ tasks: [] }, invokeConfig(workspaceId));
    expect(String(result)).to.include('at least one task');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('rejects a batch over the size cap, without creating any task', async () => {
    const tasks = Array.from({ length: 21 }, (_, i) => ({ title: `task ${i}` }));
    const result = await makeCreateTasksTool().invoke({ tasks }, invokeConfig(workspaceId));
    expect(String(result)).to.include('limit is 20');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('rejects the whole batch when any single entry has no title', async () => {
    const result = await makeCreateTasksTool().invoke(
      { tasks: [{ title: 'good' }, { title: '' }] },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.include('Task 2');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('rejects when the workspace no longer exists', async () => {
    const result = await makeCreateTasksTool().invoke(
      { tasks: [{ title: 'a' }] },
      invokeConfig('does-not-exist'),
    );
    expect(String(result)).to.include('Workspace no longer exists');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('creates every task ready/assigned to agent, maps plan steps, and wakes the scheduler once', async () => {
    const result = await makeCreateTasksTool().invoke(
      {
        tasks: [
          { title: 'first', description: 'do the thing', plan: ['write code', 'add tests'] },
          { title: 'second' },
        ],
      },
      invokeConfig(workspaceId),
    );

    const parsed = JSON.parse(String(result)) as { created: { id: string; title: string }[] };
    expect(parsed.created.map((t) => t.title)).to.deep.equal(['first', 'second']);

    const store = getWorkspaceStore();
    const [first, second] = parsed.created.map((c) => store.getTask(c.id)!);
    expect(first.assignedTo).to.equal('agent');
    expect(first.origin).to.equal('user');
    expect(first.triggerType).to.equal('chat');
    expect(first.plan).to.deep.equal([
      { step: 'write code', done: false },
      { step: 'add tests', done: false },
    ]);

    // wake() ran synchronously and (with no executor) dequeued the first
    // entry, proving the batch actually enqueued rather than sitting idle.
    expect(store.getTask(first.id)!.status).to.equal('running');
    expect(second.status).to.equal('ready');
  });

  it('links every task in the batch to the same resolved tracker item', async () => {
    const registry = new TrackerRegistry();
    registry.register(
      fakeAdapter('github', {
        resolveUrl: async (url) => ({
          id: 'owner/repo#42',
          url,
          title: 'Fix the bug',
          state: 'pending',
          trackerState: 'open',
        }),
      }),
    );

    const result = await makeCreateTasksTool(undefined, registry).invoke(
      { trackerUrl: 'https://github.com/owner/repo/issues/42', tasks: [{ title: 'a' }, { title: 'b' }] },
      invokeConfig(workspaceId),
    );
    const parsed = JSON.parse(String(result)) as { created: { id: string }[] };

    const store = getWorkspaceStore();
    for (const { id } of parsed.created) {
      const task = store.getTask(id)!;
      expect(task.trackerType).to.equal('github');
      expect(task.trackerId).to.equal('owner/repo#42');
    }
  });

  it('rejects the whole batch when the tracker URL cannot be resolved', async () => {
    const registry = new TrackerRegistry();
    registry.register(
      fakeAdapter('github', {
        resolveUrl: async () => {
          throw new Error('404 Not Found');
        },
      }),
    );

    const result = await makeCreateTasksTool(undefined, registry).invoke(
      { trackerUrl: 'https://github.com/owner/repo/issues/999', tasks: [{ title: 'a' }] },
      invokeConfig(workspaceId),
    );
    expect(String(result)).to.include('Could not link tracker');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('creates two independent batches when called twice in one turn (no idempotency guard)', async () => {
    const toolInstance = makeCreateTasksTool();
    await toolInstance.invoke({ tasks: [{ title: 'a' }] }, invokeConfig(workspaceId));
    await toolInstance.invoke({ tasks: [{ title: 'a' }] }, invokeConfig(workspaceId));

    expect(getWorkspaceStore().listTasks({}).length).to.equal(2);
  });
});
