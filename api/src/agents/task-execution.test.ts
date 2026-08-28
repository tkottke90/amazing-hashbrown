import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore, type ThreadStore } from '../services/thread-store.js';
import {
  WorkspaceStore,
  bootWorkspaceStore,
  type Task,
  type TaskQueueEntry,
} from '../services/workspace-store.js';
import { getActiveSseWriter } from './active-sse-writer.js';
import { executeTask, type QueueEntryWithTask } from './task-execution.js';
import type { buildTaskAgent } from './chat-agent.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawEvent = Record<string, any>;

// Mirrors stream-handler.test.ts's stubAgent() — a plain object satisfying
// the structural shape executeTask()/pipeEvents()/finalizeTurn() actually
// use (streamEvents + graph.getState), not the real LangChain agent.
function fakeAgent(events: RawEvent[], interruptValue: Record<string, unknown> | null = null) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamEvents: (): AsyncIterable<any> => {
      async function* gen() {
        for (const e of events) yield e;
      }
      return gen();
    },
    graph: {
      getState: async () => ({
        tasks: interruptValue ? [{ interrupts: [{ value: interruptValue }] }] : [],
        config: { configurable: { checkpoint_id: 'cp-test' } },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeThrowingAgent(eventsBeforeThrow: RawEvent[]) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamEvents: (): AsyncIterable<any> => {
      async function* gen() {
        for (const e of eventsBeforeThrow) yield e;
        throw new Error('simulated stream failure');
      }
      return gen();
    },
    graph: {
      getState: async () => ({
        tasks: [],
        config: { configurable: { checkpoint_id: 'cp-test' } },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeBuildTaskAgent(agent: any): typeof buildTaskAgent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => ({ agent, systemPrompt: 'test' })) as any;
}

const COMPLETE_TASK_DONE_EVENTS: RawEvent[] = [
  {
    event: 'on_tool_start',
    name: 'complete_task',
    run_id: 'ct-1',
    data: { input: { outcome: 'done', summary: 'Wrote the page.' } },
  },
  { event: 'on_tool_end', name: 'complete_task', run_id: 'ct-1', data: { output: 'ok' } },
];

const COMPLETE_TASK_FAILED_EVENTS: RawEvent[] = [
  {
    event: 'on_tool_start',
    name: 'complete_task',
    run_id: 'ct-2',
    data: { input: { outcome: 'failed', summary: 'Could not find the domain.' } },
  },
  { event: 'on_tool_end', name: 'complete_task', run_id: 'ct-2', data: { output: 'ok' } },
];

describe('agents/task-execution', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: WorkspaceStore;
  let threadStore: ThreadStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-execution-test-'));
    db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    bootWorkspaceStore(db);
    bootThreadStore(db);
    threadStore = getThreadStore();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeGlobalEntry(title = 'Global task'): QueueEntryWithTask {
    const task = store.createTask({ title, assignedTo: 'agent' });
    store.patchTask(task.id, { status: 'ready' });
    store.enqueueTask(task.id);
    return store.dequeueNext()! as QueueEntryWithTask;
  }

  function makeWorkspaceEntry(title = 'Workspace task'): {
    entry: QueueEntryWithTask;
    workspaceId: string;
  } {
    const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
    const task = store.createTask({ title, assignedTo: 'agent', workspaceId: workspace.id });
    store.patchTask(task.id, { status: 'ready' });
    store.enqueueTask(task.id);
    return { entry: store.dequeueNext()! as QueueEntryWithTask, workspaceId: workspace.id };
  }

  it('marks the task done when complete_task is called with outcome "done"', async () => {
    const entry = makeGlobalEntry();
    await executeTask(entry, {
      buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
    });

    const task = store.getTask(entry.task.id)!;
    expect(task.status).to.equal('done');
    const queue = store.listQueue().find((q) => q.id === entry.id);
    expect(queue).to.equal(undefined); // 'done' entries fall out of the active-status filter
  });

  it('marks the task failed when complete_task is called with outcome "failed"', async () => {
    const entry = makeGlobalEntry();
    await executeTask(entry, {
      buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_FAILED_EVENTS)),
    });

    const task = store.getTask(entry.task.id)!;
    expect(task.status).to.equal('failed');
  });

  it('sets waiting_on_user (and reassigns to the user) on an ask_user-shaped interrupt', async () => {
    const entry = makeGlobalEntry();
    const agent = fakeAgent([], { kind: 'free_text', question: 'Which domain should I use?' });

    await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

    const task = store.getTask(entry.task.id)!;
    expect(task.status).to.equal('waiting_on_user');
    expect(task.assignedTo).to.equal('user');

    // The queue entry itself is done — off the scheduler's plate — even
    // though the task is not; task_queue has no waiting_on_user status.
    expect(store.listQueue().find((q) => q.id === entry.id)).to.equal(undefined);

    // The persisted hitl_prompt row carries taskId, so the /hitl route can
    // re-enqueue this exact task instead of resuming an interactive turn.
    const messages = threadStore.getThreadMessages(task.threadId!, { showErrors: true });
    const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
    expect(hitlRow, 'expected a persisted hitl_prompt row').to.not.equal(undefined);
    expect((hitlRow!.payload as Record<string, unknown>).taskId).to.equal(task.id);
  });

  it('marks the task failed when the agent stops without calling complete_task or ask_user', async () => {
    const entry = makeGlobalEntry();
    const agent = fakeAgent([
      { event: 'on_chat_model_stream', data: { chunk: { content: 'Still thinking...' } } },
    ]);

    await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

    const task = store.getTask(entry.task.id)!;
    expect(task.status).to.equal('failed');
  });

  it('marks the task failed and never throws when the agent stream itself throws', async () => {
    const entry = makeGlobalEntry();
    const agent = fakeThrowingAgent([
      { event: 'on_chat_model_stream', data: { chunk: { content: 'partial' } } },
    ]);

    let threw = false;
    try {
      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(false);

    const task = store.getTask(entry.task.id)!;
    expect(task.status).to.equal('failed');
  });

  it('mints and persists a dedicated "task" thread for a global task on first run', async () => {
    const entry = makeGlobalEntry('Global with no thread yet');
    expect(entry.task.threadId).to.equal(null);

    await executeTask(entry, {
      buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
    });

    const task = store.getTask(entry.task.id)!;
    expect(task.threadId).to.not.equal(null);
    const summary = threadStore.listThreads({ type: 'task' }).find((t) => t.id === task.threadId);
    expect(summary, 'expected a type:"task" thread row').to.not.equal(undefined);
  });

  it('reuses (or mints) the workspace thread for a workspace-scoped task', async () => {
    const { entry, workspaceId } = makeWorkspaceEntry();
    expect(store.getWorkspace(workspaceId)!.threadId).to.equal(null);

    await executeTask(entry, {
      buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
    });

    const workspace = store.getWorkspace(workspaceId)!;
    expect(workspace.threadId).to.not.equal(null);
    const summary = threadStore
      .listThreads({ type: 'workspace-chat' })
      .find((t) => t.id === workspace.threadId);
    expect(summary, 'expected a workspace-chat thread row').to.not.equal(undefined);
  });

  it('writes start and end task_run_marker rows bracketing the run', async () => {
    const entry = makeGlobalEntry();
    await executeTask(entry, {
      buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
    });

    const task = store.getTask(entry.task.id)!;
    const markers = threadStore
      .getThreadMessages(task.threadId!, { showErrors: true })
      .filter((m) => m.kind === 'task_run_marker');
    expect(markers).to.have.length(2);
    const start = markers.find((m) => (m.payload as Record<string, unknown>).phase === 'start');
    const end = markers.find((m) => (m.payload as Record<string, unknown>).phase === 'end');
    expect(start, 'expected a start marker').to.not.equal(undefined);
    expect(end, 'expected an end marker').to.not.equal(undefined);
    expect((end!.payload as Record<string, unknown>).outcome).to.equal('done');
  });

  it('clears the active SSE writer slot after the run, including after a thrown error', async () => {
    const entry = makeGlobalEntry();
    const agent = fakeThrowingAgent([]);

    await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

    const task = store.getTask(entry.task.id)!;
    expect(getActiveSseWriter(task.threadId!)).to.equal(undefined);
  });
});
