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
  getWorkspaceStore,
  type Task,
  type TaskQueueEntry,
} from '../services/workspace-store.js';
import {
  getActiveSseWriter,
  setActiveSseWriter,
  clearActiveSseWriter,
} from './active-sse-writer.js';
import { getTaskAbort, setAbortIntent, type AbortIntent } from './active-task-abort.js';
import { drainPendingTurns } from './pending-thread-turns.js';
import { executeTask, type QueueEntryWithTask } from './task-execution.js';
import type { buildTaskAgent, TaskAgentHooks } from './chat-agent.js';
import { makeCompleteTaskTool } from './tools/complete-task.tool.js';
import { registerBroadcastClient, unregisterBroadcastClient } from '../services/broadcast.js';
import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';

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

// Mirrors fakeThrowingAgent, but the thrown error carries name:
// 'GraphInterrupt' — simulating LangGraph raising interrupt() as a thrown
// exception mid-stream rather than completing normally with it parked in
// checkpoint state. getState() reports interruptValue as the parked
// interrupt (or none, for the safety-net case where the name matches but
// no interrupt is actually found).
function fakeGraphInterruptAgent(
  eventsBeforeThrow: RawEvent[],
  interruptValue: Record<string, unknown> | null,
) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamEvents: (): AsyncIterable<any> => {
      async function* gen() {
        for (const e of eventsBeforeThrow) yield e;
        throw Object.assign(new Error('Interrupted by shell_approval'), { name: 'GraphInterrupt' });
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

// The generator aborts the real controller registered by executeTask's own
// registerTaskAbort() call and sets the intent, then throws — this
// sidesteps any ordering race between the test and that real call, since
// the abort registry entry only exists once executeTask itself creates it.
function fakeAbortingAgent(
  queueEntryId: string,
  intent: AbortIntent,
  eventsBeforeAbort: RawEvent[] = [],
) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamEvents: (): AsyncIterable<any> => {
      async function* gen() {
        for (const e of eventsBeforeAbort) yield e;
        const abortEntry = getTaskAbort(queueEntryId);
        if (!abortEntry) throw new Error('test setup error: no abort entry registered');
        setAbortIntent(queueEntryId, intent);
        // Simulates the actual AbortSignal firing (which is what would
        // reject/interrupt a real streamEvents() call mid-flight).
        abortEntry.controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
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

// Checks options.signal.aborted the moment streamEvents() is invoked, rather
// than yielding first — mimics a real controller that was already aborted
// *before* the deferred run started (see the thread-mutex serialization
// describe block below), unlike fakeAbortingAgent which aborts mid-stream.
function fakePreAbortedAgent() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamEvents: (_input: unknown, options: { signal?: AbortSignal }): AsyncIterable<any> => {
      async function* gen() {
        if (options.signal?.aborted) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        // Only reached if this fake is ever used with a not-yet-aborted
        // signal, which no current test does — kept so this stays a real
        // generator (require-yield) rather than an always-throwing stub.
        yield { event: 'on_chat_model_stream', data: { chunk: { content: '' } } };
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

// Captures the `input` argument passed to streamEvents so a test can assert
// on the kickoff message's exact content (fresh-start vs. continuation).
function fakeCapturingAgent(events: RawEvent[], capture: { input: unknown }) {
  return {
    streamEvents: (input: unknown): AsyncIterable<RawEvent> => {
      capture.input = input;
      async function* gen() {
        for (const e of events) yield e;
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

// Completion is decided by the complete_task tool itself (it can reject a
// "done" call — see complete-task.tool.ts), which reports acceptance through
// buildTaskAgent's onTaskComplete hook. The fake agents above only replay
// stream events, so this wraps each one: whenever it replays complete_task's
// on_tool_start, the *real* complete_task tool is invoked with those args,
// wired exactly the way buildTaskAgent wires it (getPlan from the store,
// onAccepted = the hook). That keeps the accept/nudge logic real rather than
// re-implemented here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeBuildTaskAgent(agent: any): typeof buildTaskAgent {
  return (async (
    task: Task,
    _provider?: string,
    _model?: string,
    _workspaceScope?: unknown,
    hooks?: TaskAgentHooks,
  ) => {
    const completeTask = makeCompleteTaskTool(task.id, {
      getPlan: () => getWorkspaceStore().getTask(task.id)?.plan ?? null,
      onAccepted: hooks?.onTaskComplete,
    });
    return {
      agent: {
        ...agent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        streamEvents: (...args: any[]): AsyncIterable<RawEvent> => {
          const inner: AsyncIterable<RawEvent> = agent.streamEvents(...args);
          async function* gen() {
            for await (const e of inner) {
              if (e.event === 'on_tool_start' && e.name === 'complete_task') {
                await completeTask.invoke(e.data.input);
              }
              yield e;
            }
          }
          return gen();
        },
      },
      systemPrompt: 'test',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
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

  describe('plan nudge (issue #203)', () => {
    const UNCHECKED_PLAN = [
      { step: 'Write the code', done: true },
      { step: 'Write the tests', done: false },
    ];

    function completeTaskCall(runId: string): RawEvent[] {
      return [
        {
          event: 'on_tool_start',
          name: 'complete_task',
          run_id: runId,
          data: { input: { outcome: 'done', summary: 'Shipped it.' } },
        },
        { event: 'on_tool_end', name: 'complete_task', run_id: runId, data: { output: 'ok' } },
      ];
    }

    it('fails a run whose only "done" call was nudged — the agent never confirmed completion [orchestration]', async () => {
      const entry = makeGlobalEntry();
      store.patchTask(entry.task.id, { plan: UNCHECKED_PLAN });

      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(completeTaskCall('ct-a'))),
      });

      expect(store.getTask(entry.task.id)!.status).to.equal('failed');
    });

    it('completes a run once the agent repeats "done" after the nudge [orchestration]', async () => {
      const entry = makeGlobalEntry();
      store.patchTask(entry.task.id, { plan: UNCHECKED_PLAN });

      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(
          fakeAgent([...completeTaskCall('ct-a'), ...completeTaskCall('ct-b')]),
        ),
      });

      expect(store.getTask(entry.task.id)!.status).to.equal('done');
    });

    it('completes on the first "done" when every plan step is already checked [orchestration]', async () => {
      const entry = makeGlobalEntry();
      store.patchTask(entry.task.id, {
        plan: UNCHECKED_PLAN.map((p) => ({ ...p, done: true })),
      });

      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(completeTaskCall('ct-a'))),
      });

      expect(store.getTask(entry.task.id)!.status).to.equal('done');
    });
  });

  // Regression: workspace-chat's shared checkpoint thread means
  // agent.graph.getState() can report a pending interrupt left over from
  // extra tool-call activity in the *same* run that also called
  // complete_task (e.g. the model does one more shell_exec — a redundant
  // verification step — right after declaring the task done). finalizeTurn()
  // unconditionally dispatches any interrupt it finds in post-stream state,
  // before task-execution.ts ever gets to check completeTaskBox — so without
  // this fix, a real hitl_prompt row gets durably written and shown to the
  // user for a task that has already completed, with no parked queue row
  // ever backing it (parkQueueEntryForHitl is only called in the `else if
  // (interrupted)` branch, which completeTaskBox.current already won). That
  // orphaned, un-park-able prompt is exactly what later lets a stale /hitl
  // answer re-enqueue an already-finished task — see workspace-chat.route.ts's
  // own regression test for that half of the bug.
  it(
    'does not leave a dangling hitl_prompt when complete_task fires and the final ' +
      'graph state also reports a pending interrupt from the same run',
    async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAgent(COMPLETE_TASK_DONE_EVENTS, {
        kind: 'shell_approval',
        command: 'ls -la',
        reason: 'redundant verification after completion',
      });

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      // The real completion must still win — this isn't in question.
      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('done');
      const queueEntry = store.listQueue().find((q) => q.id === entry.id);
      expect(queueEntry).to.equal(undefined); // 'done' entries fall out of the active-status filter

      // The bug: a hitl_prompt row for this same, already-completed task
      // must not be left sitting there for the user to click later.
      const messages = threadStore.getThreadMessages(task.threadId!);
      const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
      expect(
        hitlRow,
        'expected no orphaned hitl_prompt row once complete_task has already won',
      ).to.equal(undefined);
    },
  );

  it('sets waiting_on_user (and reassigns to the user) on an ask_user-shaped interrupt', async () => {
    const entry = makeGlobalEntry();
    const agent = fakeAgent([], { kind: 'free_text', question: 'Which domain should I use?' });

    await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

    const task = store.getTask(entry.task.id)!;
    expect(task.status).to.equal('waiting_on_user');
    expect(task.assignedTo).to.equal('user');

    // The queue row is parked, not closed — it keeps its original queue
    // position (parkQueueEntryForHitl()) so a resume via the /hitl route
    // can't be queue-jumped by a sibling task that hasn't started yet.
    const queueEntry = store.listQueue().find((q) => q.id === entry.id);
    expect(queueEntry, 'expected the queue row to still exist, parked').to.not.equal(undefined);
    expect(queueEntry!.status).to.equal('paused');
    expect(queueEntry!.pauseReason).to.equal('chat');

    // The persisted hitl_prompt row carries taskId, so the /hitl route can
    // re-enqueue this exact task instead of resuming an interactive turn.
    const messages = threadStore.getThreadMessages(task.threadId!);
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

  it('persists a classified errorCategory/error on the failed assistant row when the agent stream throws', async () => {
    const entry = makeGlobalEntry();
    const agent = fakeThrowingAgent([
      { event: 'on_chat_model_stream', data: { chunk: { content: 'partial' } } },
    ]);

    await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

    const task = store.getTask(entry.task.id)!;
    const messages = threadStore.getThreadMessages(task.threadId!);
    const assistantRow = messages.find((m) => m.kind === 'assistant' && m.status === 'error');
    expect(assistantRow, 'expected a failed assistant row').to.not.equal(undefined);
    const payload = assistantRow!.payload as Record<string, unknown>;
    // The thrown error ("simulated stream failure") has no structured
    // status/type/code for classifyChatError to key off, so it resolves to
    // 'unknown' — this asserts the classification pipeline actually ran
    // (env.defaultProvider was passed through), not any specific category.
    expect(payload.error).to.equal('simulated stream failure');
    expect(payload.errorCategory).to.equal('unknown');
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
      .getThreadMessages(task.threadId!)
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

  describe('abort handling (cancel / pause / take-over)', () => {
    it('marks the task cancelled when the abort registry shows a "cancel" intent', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAbortingAgent(entry.id, 'cancel', [
        { event: 'on_chat_model_stream', data: { chunk: { content: 'partial' } } },
      ]);

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('cancelled');
      // 'cancelled' entries fall out of listQueue()'s active-status filter.
      expect(store.listQueue().find((q) => q.id === entry.id)).to.equal(undefined);
    });

    it('parks the task at "blocked" when the abort registry shows a "pause" intent', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAbortingAgent(entry.id, 'pause');

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('blocked');
      const queue = store.listQueue().find((q) => q.id === entry.id)!;
      expect(queue.status).to.equal('paused');
      expect(queue.pauseReason).to.equal('user');
      expect(queue.pausedAt).to.not.equal(null);
    });

    it('retires the queue row without touching status/assignedTo on a "take-over" intent', async () => {
      const entry = makeGlobalEntry();
      // Simulates the take-over route handler's synchronous pre-write,
      // committed before the abort is even triggered.
      store.patchTask(entry.task.id, { status: 'pending', assignedTo: 'user' });
      const agent = fakeAbortingAgent(entry.id, 'take-over');

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('pending');
      expect(task.assignedTo).to.equal('user');
      expect(store.listQueue().find((q) => q.id === entry.id)).to.equal(undefined);
    });

    it('still marks the task failed when the stream throws with no abort intent recorded (regression)', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeThrowingAgent([]);

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('failed');
    });

    it('sends a continuation-flavored kickoff message when resuming a paused entry', async () => {
      const fresh = makeGlobalEntry('Resume me');
      store.parkQueueEntry(fresh.id);
      store.resumePausedEntry(fresh.id);
      const resumed = store.dequeueNext()! as QueueEntryWithTask;
      expect(resumed.pausedAt, 'expected pausedAt to survive the resume').to.not.equal(null);

      const capture: { input: unknown } = { input: undefined };
      await executeTask(resumed, {
        buildTaskAgent: fakeBuildTaskAgent(fakeCapturingAgent(COMPLETE_TASK_DONE_EVENTS, capture)),
      });

      const input = capture.input as { messages: { role: string; content: string }[] };
      expect(input.messages[0].content).to.include('continue from where you left off');
    });

    it('sends the fresh-start kickoff message for a task that was never paused (regression)', async () => {
      const entry = makeGlobalEntry('Fresh task');
      const capture: { input: unknown } = { input: undefined };

      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeCapturingAgent(COMPLETE_TASK_DONE_EVENTS, capture)),
      });

      const input = capture.input as { messages: { role: string; content: string }[] };
      expect(input.messages[0].content).to.include('Begin work on this task now');
    });
  });

  describe("sub-agent completion notification (origin='agent' — issue #161)", () => {
    // No provider is configured in this test environment, so
    // deliverSubAgentCompletion()'s attempt to actually build the parent's
    // agent and run a notification turn fails harmlessly inside its own
    // try/catch (never throws — see sub-agent-notification.ts) — these
    // tests assert on the synchronous, provider-independent part of that
    // flow: the sub_agent_marker written into the parent thread before the
    // agent build is even attempted.
    function makeSubAgentEntry(
      opts: {
        role?: string;
        goal?: string;
        parentThreadId?: string;
        dispatchGroupId?: string;
      } = {},
    ): QueueEntryWithTask {
      const parentThreadId = opts.parentThreadId ?? 'parent-thread-1';
      threadStore.upsertThreadOnFirstMessage(parentThreadId, 'Parent', 'chat');
      store.createSubAgentTask({
        role: opts.role ?? 'researcher',
        goal: opts.goal ?? 'Find something',
        parentThreadId,
        dispatchGroupId: opts.dispatchGroupId ?? 'group-1',
      });
      return store.dequeueNext()! as QueueEntryWithTask;
    }

    function completionMarkers(parentThreadId: string) {
      return threadStore
        .getThreadMessages(parentThreadId)
        .filter(
          (m) =>
            m.kind === 'sub_agent_marker' &&
            (m.payload as Record<string, unknown>).phase === 'completion',
        );
    }

    it('writes a completion sub_agent_marker into the parent thread when complete_task fires', async () => {
      const entry = makeSubAgentEntry({ parentThreadId: 'parent-a', dispatchGroupId: 'group-a' });

      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      expect(store.getTask(entry.task.id)!.status).to.equal('done');
      const markers = completionMarkers('parent-a');
      expect(markers).to.have.length(1);
      const payload = markers[0]!.payload as Record<string, unknown>;
      expect(payload.taskId).to.equal(entry.task.id);
      expect(payload.role).to.equal('researcher');
      expect(payload.outcome).to.equal('done');
      expect(payload.remainingCount).to.equal(0);
    });

    it('computes remainingCount against a still-pending sibling sharing dispatchGroupId', async () => {
      const first = makeSubAgentEntry({ parentThreadId: 'parent-b', dispatchGroupId: 'group-b' });
      // A sibling created after — sharing the same dispatchGroupId/parent —
      // stays queued (never dequeued), simulating it still being in flight.
      store.createSubAgentTask({
        role: 'researcher',
        goal: 'sibling goal',
        parentThreadId: 'parent-b',
        dispatchGroupId: 'group-b',
      });

      await executeTask(first, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      const markers = completionMarkers('parent-b');
      expect(markers).to.have.length(1);
      expect((markers[0]!.payload as Record<string, unknown>).remainingCount).to.equal(1);
    });

    it('delivers a failed-outcome notification when the agent stops without calling complete_task', async () => {
      const entry = makeSubAgentEntry({ parentThreadId: 'parent-c', dispatchGroupId: 'group-c' });
      const agent = fakeAgent([
        { event: 'on_chat_model_stream', data: { chunk: { content: 'Still thinking...' } } },
      ]);

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      expect(store.getTask(entry.task.id)!.status).to.equal('failed');
      const markers = completionMarkers('parent-c');
      expect(markers).to.have.length(1);
      expect((markers[0]!.payload as Record<string, unknown>).outcome).to.equal('failed');
    });

    it('delivers a cancelled-outcome notification when the abort registry shows a "cancel" intent', async () => {
      const entry = makeSubAgentEntry({ parentThreadId: 'parent-d', dispatchGroupId: 'group-d' });
      const agent = fakeAbortingAgent(entry.id, 'cancel', [
        { event: 'on_chat_model_stream', data: { chunk: { content: 'partial' } } },
      ]);

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      expect(store.getTask(entry.task.id)!.status).to.equal('cancelled');
      const markers = completionMarkers('parent-d');
      expect(markers).to.have.length(1);
      expect((markers[0]!.payload as Record<string, unknown>).outcome).to.equal('cancelled');
    });

    it("does not write a sub_agent_marker for an ordinary origin='user' task", async () => {
      const entry = makeGlobalEntry('Ordinary task');
      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      const task = store.getTask(entry.task.id)!;
      const markers = threadStore
        .getThreadMessages(task.threadId!)
        .filter((m) => m.kind === 'sub_agent_marker');
      expect(markers).to.have.length(0);
    });
  });

  describe('GraphInterrupt escaping as a thrown exception (regression)', () => {
    // Reproduces the production bug: shell_exec's interrupt() call surfaces
    // as a thrown GraphInterrupt mid-stream (not a graceful pipeEvents
    // return), which used to fall into the generic catch-all and mark the
    // task 'failed' — silently losing the approval request. See this
    // branch's own comment in task-execution.ts for the fix.
    it('sets waiting_on_user and persists the approval prompt on a shell_approval-shaped GraphInterrupt', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeGraphInterruptAgent(
        [{ event: 'on_chat_model_stream', data: { chunk: { content: 'Running the command...' } } }],
        { kind: 'shell_approval', command: 'npm install', reason: 'Install dependencies' },
      );

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('waiting_on_user');
      expect(task.assignedTo).to.equal('user');
      // The queue row is parked, not closed — same as the graceful
      // (non-throwing) interrupt path.
      const queueEntry = store.listQueue().find((q) => q.id === entry.id);
      expect(queueEntry, 'expected the queue row to still exist, parked').to.not.equal(undefined);
      expect(queueEntry!.status).to.equal('paused');
      expect(queueEntry!.pauseReason).to.equal('chat');

      const messages = threadStore.getThreadMessages(task.threadId!);
      const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
      expect(hitlRow, 'expected a persisted hitl_prompt row').to.not.equal(undefined);
      const payload = hitlRow!.payload as Record<string, unknown>;
      expect(payload.taskId).to.equal(task.id);
      expect(payload.promptKind).to.equal('shell_approval');
      expect(payload.command).to.equal('npm install');

      // The pre-interrupt partial content must be preserved, not discarded —
      // asserted as a prefix rather than an exact match since flushDelta
      // withholds a small safety margin of trailing text in case it's a
      // split <think> tag boundary (see stream-handler.ts's SAFE_MARGIN).
      const assistantRow = messages.find((m) => m.kind === 'assistant' && m.status === 'done');
      expect(assistantRow, 'expected the partial assistant turn to be finalized').to.not.equal(
        undefined,
      );
      const partialContent = (assistantRow!.payload as Record<string, unknown>).content as string;
      expect(partialContent.length).to.be.greaterThan(0);
      expect('Running the command...').to.include(partialContent);
    });

    it('records the end task_run_marker with outcome waiting_on_user', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeGraphInterruptAgent([], { kind: 'shell_approval', command: 'ls' });

      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      const markers = threadStore
        .getThreadMessages(task.threadId!)
        .filter((m) => m.kind === 'task_run_marker');
      const end = markers.find((m) => (m.payload as Record<string, unknown>).phase === 'end');
      expect(end, 'expected an end marker').to.not.equal(undefined);
      expect((end!.payload as Record<string, unknown>).outcome).to.equal('waiting_on_user');
    });

    it('falls back to failed (without throwing) when the error name matches but checkpoint state has no interrupt', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeGraphInterruptAgent([], null);

      let threw = false;
      try {
        await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });
      } catch {
        threw = true;
      }
      expect(threw).to.equal(false);

      const task = store.getTask(entry.task.id)!;
      expect(task.status).to.equal('failed');
      expect(store.listQueue().find((q) => q.id === entry.id)).to.equal(undefined);
    });
  });

  // A workspace-scoped task shares its LangGraph checkpoint thread_id with
  // the workspace's own interactive chat, and dequeueNext()'s per-scope
  // serialization excludes origin='agent' rows — either way, two runs could
  // previously race the same thread_id's agent.streamEvents() call and lose
  // a parked interrupt. executeTask() now checks the same per-thread mutex
  // (active-sse-writer.ts) every interactive handler already respects, and
  // defers via runOnceThreadFree() (pending-thread-turns.ts) instead of
  // racing. See this session's design doc for the full diagnosis.
  describe('thread-mutex serialization (regression)', () => {
    // A pre-assigned, known thread id (rather than one executeTask mints
    // itself) so the mutex can be seeded busy *before* calling executeTask.
    const THREAD_ID = 'preassigned-thread-for-mutex-test';

    afterEach(() => {
      clearActiveSseWriter(THREAD_ID);
    });

    function makeGlobalEntryOnThread(threadId: string, title = 'Global task'): QueueEntryWithTask {
      const task = store.createTask({ title, assignedTo: 'agent' });
      store.patchTask(task.id, { status: 'ready', threadId });
      store.enqueueTask(task.id);
      return store.dequeueNext()! as QueueEntryWithTask;
    }

    it('defers execution until the thread mutex clears, then completes normally', async () => {
      const entry = makeGlobalEntryOnThread(THREAD_ID);
      setActiveSseWriter(THREAD_ID, () => {});

      // A global task's own thread-resolution preamble (registerTaskAbort +
      // the synchronous threadId branch — no `await` in it) runs fully
      // synchronously, so by the time this call returns its pending
      // promise, executeTask has already reached the mutex check and
      // queued itself — no timing hack needed to prove it deferred rather
      // than racing.
      const runPromise = executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      // Still held — claimed 'running' by dequeueNext(), but not advanced
      // any further since runClaimed() hasn't started yet.
      expect(store.getTask(entry.task.id)!.status).to.equal('running');

      clearActiveSseWriter(THREAD_ID);
      drainPendingTurns(THREAD_ID);
      await runPromise;

      expect(store.getTask(entry.task.id)!.status).to.equal('done');
    });

    it('runs immediately with no deferral when the thread mutex is already free', async () => {
      const entry = makeGlobalEntryOnThread(THREAD_ID);

      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      expect(store.getTask(entry.task.id)!.status).to.equal('done');
      expect(getActiveSseWriter(THREAD_ID)).to.equal(undefined);
    });

    it('a workspace-scoped origin="agent" sub-agent task also defers when the thread mutex is already held (closes the dequeueNext() scope-exclusion gap)', async () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      store.patchWorkspace(workspace.id, { threadId: THREAD_ID });
      store.createSubAgentTask({
        role: 'researcher',
        goal: 'Do something',
        parentThreadId: 'parent-thread',
        dispatchGroupId: 'group-1',
        workspaceId: workspace.id,
      });
      const entry = store.dequeueNext()! as QueueEntryWithTask;
      expect(entry.task.origin).to.equal('agent');

      setActiveSseWriter(THREAD_ID, () => {});

      const runPromise = executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      // Unlike the global-task tests above, a workspace-scoped task's own
      // thread-resolution has a real await (buildWorkspaceContext reading
      // the workspace's .hashbrown/summaries dir) before it reaches the
      // mutex check, so there's no synchronous guarantee it's already
      // queued the instant this call returns. Give that a moment to settle,
      // then assert the task is *still* 'running' (not yet 'done') before
      // freeing the mutex — if this fix regressed and the second task raced
      // ahead instead of deferring, this assertion (not just the final one)
      // would catch it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.getTask(entry.task.id)!.status).to.equal('running');

      clearActiveSseWriter(THREAD_ID);
      drainPendingTurns(THREAD_ID);
      await runPromise;

      expect(store.getTask(entry.task.id)!.status).to.equal('done');
    });

    it('ends cancelled (not failed) when cancelled while still queued behind a busy thread', async () => {
      const entry = makeGlobalEntryOnThread(THREAD_ID);
      setActiveSseWriter(THREAD_ID, () => {});

      const runPromise = executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakePreAbortedAgent()),
      });

      // Cancel while still queued (not yet running) — registerTaskAbort()
      // already ran synchronously before the mutex check, so the abort
      // entry exists even though runClaimed() hasn't started yet.
      const abortEntry = getTaskAbort(entry.id);
      expect(abortEntry, 'expected an abort entry to exist while queued').to.not.equal(undefined);
      setAbortIntent(entry.id, 'cancel');
      abortEntry!.controller.abort();

      clearActiveSseWriter(THREAD_ID);
      drainPendingTurns(THREAD_ID);
      await runPromise;

      expect(store.getTask(entry.task.id)!.status).to.equal('cancelled');
    });
  });

  // Regression coverage for the live-events broadcast hook added to
  // executeTask()'s finally block (see
  // docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md) — a
  // separate describe block re-driving the same fake-agent scenarios as the
  // tests above, purely to assert the right broadcast() call, so a
  // broadcast-wiring regression doesn't get buried inside an unrelated
  // assertion. Uses the real registry (broadcast.ts), same as
  // task-scheduler.test.ts's equivalent coverage, rather than stubbing the
  // module import.
  describe('broadcast wiring (live events)', () => {
    let received: AppBroadcastEvent[];
    let writer: (event: AppBroadcastEvent) => void;

    beforeEach(() => {
      received = [];
      writer = (event) => received.push(event);
      registerBroadcastClient(writer);
    });

    afterEach(() => {
      unregisterBroadcastClient(writer);
    });

    it('broadcasts task_completed with outcome "done" when complete_task succeeds', async () => {
      const entry = makeGlobalEntry();
      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_DONE_EVENTS)),
      });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
        { type: 'task_completed', threadId: task.threadId, taskId: task.id, outcome: 'done' },
      ]);
    });

    it('broadcasts task_completed with outcome "failed" when complete_task reports failure', async () => {
      const entry = makeGlobalEntry();
      await executeTask(entry, {
        buildTaskAgent: fakeBuildTaskAgent(fakeAgent(COMPLETE_TASK_FAILED_EVENTS)),
      });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
        { type: 'task_completed', threadId: task.threadId, taskId: task.id, outcome: 'failed' },
      ]);
    });

    it('broadcasts task_completed with outcome "failed" when the agent stops without calling complete_task', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAgent([
        { event: 'on_chat_model_stream', data: { chunk: { content: 'Still thinking...' } } },
      ]);
      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
        { type: 'task_completed', threadId: task.threadId, taskId: task.id, outcome: 'failed' },
      ]);
    });

    it('broadcasts hitl_prompt on a graceful (non-throwing) interrupt', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAgent([], { kind: 'free_text', question: 'Which domain?' });
      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
        { type: 'hitl_prompt', threadId: task.threadId, taskId: task.id },
      ]);
    });

    it('broadcasts hitl_prompt on a thrown GraphInterrupt', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeGraphInterruptAgent([], { kind: 'shell_approval', command: 'ls' });
      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
        { type: 'hitl_prompt', threadId: task.threadId, taskId: task.id },
      ]);
    });

    it('broadcasts task_completed with outcome "cancelled" on a cancel-intent abort', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAbortingAgent(entry.id, 'cancel');
      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
        { type: 'task_completed', threadId: task.threadId, taskId: task.id, outcome: 'cancelled' },
      ]);
    });

    it('broadcasts task_started but no terminal event on a pause-intent abort ("blocked" has no thread-side content)', async () => {
      const entry = makeGlobalEntry();
      const agent = fakeAbortingAgent(entry.id, 'pause');
      await executeTask(entry, { buildTaskAgent: fakeBuildTaskAgent(agent) });

      const task = store.getTask(entry.task.id)!;
      expect(received).to.deep.equal([
        { type: 'task_started', threadId: task.threadId, taskId: task.id },
      ]);
    });
  });
});
