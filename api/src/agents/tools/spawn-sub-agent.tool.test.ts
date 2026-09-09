import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { configManager } from '../../config/env.js';
import { bootWorkspaceStore, getWorkspaceStore } from '../../services/workspace-store.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { bootTaskScheduler } from '../../services/task-scheduler.js';
import { spawnSubAgentTool, resolveDispatchGroupId } from './spawn-sub-agent.tool.js';

const THREAD_ID = 'calling-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(metadata?: Record<string, unknown>): any {
  return {
    configurable: { thread_id: THREAD_ID },
    metadata,
    toolCallId: 'call-1',
  };
}

describe('agents/tools/spawn-sub-agent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spawn-sub-agent-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    bootThreadStore(db);
    // The calling thread must already exist — in real usage this is the
    // live chat/workspace-chat/task thread the tool call is part of, always
    // created before any turn (let alone a tool call within one) happens.
    getThreadStore().upsertThreadOnFirstMessage(THREAD_ID, 'Calling thread', 'chat');
    // No executor registered — wake()/tick() dequeues (proving dispatch
    // actually enqueued and woke the scheduler) and then stops rather than
    // trying to run a real agent turn.
    bootTaskScheduler();
    configManager.set('roles', { researcher: { provider: 'test-provider', model: 'test-model' } });
  });

  afterEach(() => {
    configManager.set('roles', {});
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an unknown role without creating a task, and does not throw', async () => {
    const result = await spawnSubAgentTool.invoke(
      { role: 'no-such-role', goal: 'Find something' },
      invokeConfig(),
    );

    expect(String(result)).to.include('Unknown role');
    expect(getWorkspaceStore().listTasks({}).length).to.equal(0);
  });

  it('lists configured roles in the unknown-role error message', async () => {
    const result = await spawnSubAgentTool.invoke(
      { role: 'no-such-role', goal: 'Find something' },
      invokeConfig(),
    );
    expect(String(result)).to.include('researcher');
  });

  it('dispatches immediately: creates an origin=\'agent\' task, wakes the scheduler, and returns the dispatched id/role', async () => {
    const result = await spawnSubAgentTool.invoke(
      { role: 'researcher', goal: 'Find the answer' },
      invokeConfig(),
    );

    const parsed = JSON.parse(String(result)) as { dispatched: { id: string; role: string } };
    expect(parsed.dispatched.role).to.equal('researcher');

    const store = getWorkspaceStore();
    const task = store.getTask(parsed.dispatched.id)!;
    expect(task.origin).to.equal('agent');
    expect(task.title).to.equal('Find the answer');
    expect(task.parentThreadId).to.equal(THREAD_ID);
    expect(task.role).to.equal('researcher');

    // wake() ran synchronously and (with no executor) dequeued the entry,
    // proving the dispatch actually enqueued it rather than just writing a
    // 'pending' row nobody ever picks up.
    expect(store.getTask(parsed.dispatched.id)!.status).to.equal('running');
  });

  it('writes a dispatch sub_agent_marker into the calling thread', async () => {
    const result = await spawnSubAgentTool.invoke(
      { role: 'researcher', goal: 'Find the answer' },
      invokeConfig(),
    );
    const parsed = JSON.parse(String(result)) as { dispatched: { id: string } };

    const messages = getThreadStore().getThreadMessages(THREAD_ID);
    const marker = messages.find((m) => m.kind === 'sub_agent_marker');
    expect(marker, 'expected a dispatch sub_agent_marker').to.not.equal(undefined);
    const payload = marker!.payload as Record<string, unknown>;
    expect(payload.phase).to.equal('dispatch');
    expect(payload.taskId).to.equal(parsed.dispatched.id);
    expect(payload.role).to.equal('researcher');
  });

  it('gives two calls sharing the same batch metadata the same dispatchGroupId (siblings in one turn)', async () => {
    const metadata = { langgraph_checkpoint_ns: 'ns-1', langgraph_step: 3 };
    const r1 = await spawnSubAgentTool.invoke(
      { role: 'researcher', goal: 'part 1' },
      invokeConfig(metadata),
    );
    const r2 = await spawnSubAgentTool.invoke(
      { role: 'researcher', goal: 'part 2' },
      invokeConfig(metadata),
    );

    const p1 = JSON.parse(String(r1)) as { dispatched: { id: string } };
    const p2 = JSON.parse(String(r2)) as { dispatched: { id: string } };
    const store = getWorkspaceStore();
    const g1 = store.getTask(p1.dispatched.id)!.dispatchGroupId;
    const g2 = store.getTask(p2.dispatched.id)!.dispatchGroupId;

    expect(g1).to.not.equal(null);
    expect(g1).to.equal(g2);
  });

  it('gives two calls with different batch metadata different dispatchGroupIds', async () => {
    const r1 = await spawnSubAgentTool.invoke(
      { role: 'researcher', goal: 'part 1' },
      invokeConfig({ langgraph_checkpoint_ns: 'ns-1' }),
    );
    const r2 = await spawnSubAgentTool.invoke(
      { role: 'researcher', goal: 'part 2' },
      invokeConfig({ langgraph_checkpoint_ns: 'ns-2' }),
    );

    const p1 = JSON.parse(String(r1)) as { dispatched: { id: string } };
    const p2 = JSON.parse(String(r2)) as { dispatched: { id: string } };
    const store = getWorkspaceStore();
    expect(store.getTask(p1.dispatched.id)!.dispatchGroupId).to.not.equal(
      store.getTask(p2.dispatched.id)!.dispatchGroupId,
    );
  });
});

describe('agents/tools/spawn-sub-agent — resolveDispatchGroupId()', () => {
  it('mints a fresh group id per call when no batch metadata is present', () => {
    const a = resolveDispatchGroupId('thread-1', undefined);
    const b = resolveDispatchGroupId('thread-1', undefined);
    expect(a).to.not.equal(b);
  });

  it('reuses the same group id for the same thread+batch key', () => {
    const meta = { langgraph_checkpoint_ns: 'ns-x' };
    const a = resolveDispatchGroupId('thread-1', meta);
    const b = resolveDispatchGroupId('thread-1', meta);
    expect(a).to.equal(b);
  });

  it('gives different threads different group ids even for the same batch key', () => {
    const meta = { langgraph_checkpoint_ns: 'ns-x' };
    const a = resolveDispatchGroupId('thread-1', meta);
    const b = resolveDispatchGroupId('thread-2', meta);
    expect(a).to.not.equal(b);
  });

  it('falls back to langgraph_step when langgraph_checkpoint_ns is absent', () => {
    const a = resolveDispatchGroupId('thread-1', { langgraph_step: 5 });
    const b = resolveDispatchGroupId('thread-1', { langgraph_step: 5 });
    const c = resolveDispatchGroupId('thread-1', { langgraph_step: 6 });
    expect(a).to.equal(b);
    expect(a).to.not.equal(c);
  });
});
