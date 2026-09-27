import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';
import { ThreadStore } from '../services/thread-store.js';
import { registerBroadcastClient, unregisterBroadcastClient } from '../services/broadcast.js';
import { getActiveSseWriter, getActiveTurnAbort } from './active-sse-writer.js';
import { runHeadlessTurn, type HeadlessAgent } from './headless-turn.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawEvent = Record<string, any>;

const TEXT_EVENTS: RawEvent[] = [
  { event: 'on_chat_model_stream', data: { chunk: { content: 'The deploy ' } } },
  { event: 'on_chat_model_stream', data: { chunk: { content: 'succeeded.' } } },
];

const IDLE_GRAPH = {
  getState: async () => ({ tasks: [], config: { configurable: { checkpoint_id: 'cp-test' } } }),
};

// Streams the given events; records the options each streamEvents call got.
function fakeAgent(events: RawEvent[], seenOptions: Record<string, unknown>[] = []): HeadlessAgent {
  return {
    streamEvents: (_input, options) => {
      seenOptions.push(options);
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    graph: IDLE_GRAPH,
  };
}

function fakeThrowingAgent(error: Error): HeadlessAgent {
  return {
    streamEvents: () =>
      (async function* () {
        yield* [];
        throw error;
      })(),
    graph: IDLE_GRAPH,
  };
}

// Aborts through the controller runHeadlessTurn registered for the thread —
// exactly what the thread's /stop route does.
function fakeStoppedAgent(threadId: string): HeadlessAgent {
  return {
    streamEvents: () =>
      (async function* () {
        yield TEXT_EVENTS[0]!;
        const controller = getActiveTurnAbort(threadId);
        if (!controller) throw new Error('test setup error: no controller registered');
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      })(),
    graph: IDLE_GRAPH,
  };
}

describe('agents/headless-turn', () => {
  let dir: string;
  let threadStore: ThreadStore;
  let threadId: string;
  let received: AppBroadcastEvent[];
  const client = (event: AppBroadcastEvent) => received.push(event);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'headless-turn-test-'));
    threadStore = new ThreadStore(openDatabase(join(dir, 'test.db')));
    threadId = randomUUID();
    threadStore.upsertThreadOnFirstMessage(threadId, 'deploy chat', 'chat');
    received = [];
    registerBroadcastClient(client);
  });

  afterEach(() => {
    unregisterBroadcastClient(client);
    threadStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function assistantRows() {
    return threadStore.getThread(threadId)!.messages.filter((m) => m.kind === 'assistant');
  }

  function run(agent: HeadlessAgent, extra: { wakeupDepth?: number } = {}) {
    return runHeadlessTurn({
      threadId,
      agent,
      message: '⏰ Wake-up. Your note: "check the deploy".',
      threadStore,
      source: 'wakeup',
      ...extra,
    });
  }

  it('tells open clients the thread is busy, then that the turn ended [orchestration]', async () => {
    await run(fakeAgent(TEXT_EVENTS));

    expect(received).to.deep.equal([
      { type: 'thread_turn_started', threadId, source: 'wakeup' },
      { type: 'thread_turn_completed', threadId },
    ]);
  });

  it('records the agent reply in the thread and releases the thread [orchestration]', async () => {
    await run(fakeAgent(TEXT_EVENTS));

    const [reply] = assistantRows();
    expect(reply?.status).to.equal('done');
    expect((reply?.payload as { content: string }).content).to.equal('The deploy succeeded.');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });

  it('exposes the wake-up chain depth to tools via configurable [unit]', async () => {
    const seen: Record<string, unknown>[] = [];
    await run(fakeAgent(TEXT_EVENTS, seen), { wakeupDepth: 3 });

    const configurable = seen[0]?.configurable as Record<string, unknown>;
    expect(configurable).to.include({ thread_id: threadId, wakeupDepth: 3 });
  });

  it('leaves wakeupDepth unset for a sub-agent notification turn [unit]', async () => {
    const seen: Record<string, unknown>[] = [];
    await runHeadlessTurn({
      threadId,
      agent: fakeAgent(TEXT_EVENTS, seen),
      message: 'Sub-agent completed.',
      threadStore,
      source: 'sub_agent',
    });

    expect(seen[0]?.configurable).not.to.have.property('wakeupDepth');
    expect(received[0]).to.deep.equal({
      type: 'thread_turn_started',
      threadId,
      source: 'sub_agent',
    });
  });

  it('writes a failed turn to the thread as an error row instead of dropping it silently [orchestration]', async () => {
    await run(fakeThrowingAgent(new Error('simulated provider failure')));

    const [reply] = assistantRows();
    expect(reply?.status).to.equal('error');
    expect(reply?.payload).to.have.property('errorCategory');
    expect(received.at(-1)).to.deep.equal({ type: 'thread_turn_completed', threadId });
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });

  it('records a turn stopped through the thread abort controller as cancelled [orchestration]', async () => {
    await run(fakeStoppedAgent(threadId));

    const [reply] = assistantRows();
    expect(reply?.status).to.equal('error');
    expect(reply?.payload).to.include({ errorCategory: 'cancelled', error: 'Stopped.' });
  });

  it('never throws, even when the turn fails [unit]', async () => {
    const outcome = await run(fakeThrowingAgent(new Error('boom'))).then(
      () => 'resolved',
      () => 'rejected',
    );
    expect(outcome).to.equal('resolved');
  });
});
