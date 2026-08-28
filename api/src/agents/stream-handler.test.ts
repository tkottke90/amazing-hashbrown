import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { ThreadStore } from '../services/thread-store.js';
import { pipeEvents, finalizeTurn, makeLiveSseWriter } from './stream-handler.js';

// A minimal fake Response — makeLiveSseWriter() still takes a real
// Response-shaped object and calls res.write() internally.
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: () =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as Record<string, unknown>),
  };
}

// A minimal fake SseWriter — pipeEvents()/finalizeTurn() now take the sink
// function directly rather than a Response, so this just records the event
// objects as-is (no JSON round-trip needed).
function fakeSink() {
  const chunks: ChatSSEEvent[] = [];
  return {
    sink: (event: ChatSSEEvent) => chunks.push(event),
    events: () => chunks as unknown as Record<string, unknown>[],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* eventsFrom(events: any[]): AsyncGenerator<any> {
  for (const e of events) yield e;
}

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stream-handler-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

function stubAgent(interruptValue: Record<string, unknown> | null) {
  return {
    graph: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getState: async () => ({
        tasks: interruptValue ? [{ interrupts: [{ value: interruptValue }] }] : [],
        config: { configurable: { checkpoint_id: 'cp-test' } },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function stubObsHandler(
  overrides: {
    totalInputTokens?: number;
    totalOutputTokens?: number;
    turnDurationMs?: number;
    lastContextWindowInputTokens?: number;
  } = {},
) {
  return {
    totalInputTokens: overrides.totalInputTokens ?? 0,
    totalOutputTokens: overrides.totalOutputTokens ?? 0,
    turnDurationMs: overrides.turnDurationMs ?? 0,
    lastContextWindowInputTokens: overrides.lastContextWindowInputTokens ?? 0,
  };
}

describe('agents/stream-handler', () => {
  describe('makeLiveSseWriter', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('persists a resource_created event and attaches seq to the emitted event', () => {
      const { res, events } = fakeRes();
      const writer = makeLiveSseWriter(res, store, 't1');

      writer({
        type: 'resource_created',
        resourceType: 'workspace',
        name: 'My Workspace',
        location: '/tmp/projects/my-workspace',
        workspaceId: 'ws-1',
      });

      const emitted = events();
      expect(emitted).to.have.length(1);
      expect(emitted[0].type).to.equal('resource_created');
      expect(emitted[0].seq).to.be.a('number');

      // The row landed in thread_messages, not just the SSE stream.
      const persisted = store.getThreadMessages('t1').find((m) => m.kind === 'resource_card');
      expect(persisted, 'expected a persisted resource_card row').to.not.equal(undefined);
      expect(persisted!.payload).to.deep.equal({
        resourceType: 'workspace',
        name: 'My Workspace',
        location: '/tmp/projects/my-workspace',
        workspaceId: 'ws-1',
      });
    });

    it('passes non-resource_created events through unchanged (regression guard)', () => {
      const { res, events } = fakeRes();
      const writer = makeLiveSseWriter(res, store, 't1');

      writer({ type: 'wiki_domain_created', wikiId: 'homelab' });

      expect(events()).to.deep.equal([{ type: 'wiki_domain_created', wikiId: 'homelab' }]);
    });
  });

  describe('finalizeTurn', () => {
    it('emits stream_error and does not emit hitl_prompt when recordHitlPrompt throws', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.close(); // closed DB — recordHitlPrompt will throw, finalizeAssistant swallows via safe()
      const { sink, events } = fakeSink();
      const agent = stubAgent({ kind: 'shell_approval', command: 'ls -la', reason: 'list' });
      const result = await finalizeTurn(
        sink,
        store,
        agent,
        't1',
        'msg1',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      const emitted = events();
      expect(emitted.some((e) => e.type === 'stream_error')).to.equal(true);
      expect(emitted.some((e) => e.type === 'hitl_prompt')).to.equal(false);
      // The interrupt could not be durably recorded — there is no prompt for
      // the user to ever answer, so this must not be reported as interrupted.
      expect(result.interrupted).to.equal(false);
      rmSync(dir, { recursive: true });
    });

    it('emits usage_stats before stream_done when obsHandler is provided', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t2', 'Hello');
      const { sink, events } = fakeSink();
      const agent = stubAgent(null);
      await finalizeTurn(
        sink,
        store,
        agent,
        't2',
        'msg2',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
        stubObsHandler({
          totalInputTokens: 10,
          totalOutputTokens: 20,
          turnDurationMs: 2000,
          lastContextWindowInputTokens: 10,
        }),
      );
      const emitted = events();
      const usageIdx = emitted.findIndex((e) => e.type === 'usage_stats');
      const doneIdx = emitted.findIndex((e) => e.type === 'stream_done');
      expect(usageIdx).to.be.at.least(0);
      expect(doneIdx).to.be.at.least(0);
      expect(usageIdx).to.be.lessThan(doneIdx);
      rmSync(dir, { recursive: true });
    });

    it('computes tokensPerSecond from turnDurationMs and outputTokens', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t3', 'Hello');
      const { sink, events } = fakeSink();
      const agent = stubAgent(null);
      await finalizeTurn(
        sink,
        store,
        agent,
        't3',
        'msg3',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
        stubObsHandler({
          totalOutputTokens: 20,
          turnDurationMs: 2000,
          lastContextWindowInputTokens: 5,
        }),
      );
      const usage = events().find((e) => e.type === 'usage_stats');
      expect(usage?.tokensPerSecond).to.equal(10); // 20 tokens / 2s = 10 tok/s
      rmSync(dir, { recursive: true });
    });

    it('omits tokensPerSecond when turnDurationMs is 0', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t4', 'Hello');
      const { sink, events } = fakeSink();
      const agent = stubAgent(null);
      await finalizeTurn(
        sink,
        store,
        agent,
        't4',
        'msg4',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
        stubObsHandler({ totalOutputTokens: 20, turnDurationMs: 0 }),
      );
      const usage = events().find((e) => e.type === 'usage_stats');
      expect(usage).to.not.equal(undefined);
      expect(Object.prototype.hasOwnProperty.call(usage, 'tokensPerSecond')).to.equal(false);
      rmSync(dir, { recursive: true });
    });

    it('omits contextWindowTokens when lastContextWindowInputTokens is 0', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t5', 'Hello');
      const { sink, events } = fakeSink();
      const agent = stubAgent(null);
      await finalizeTurn(
        sink,
        store,
        agent,
        't5',
        'msg5',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
        stubObsHandler({ lastContextWindowInputTokens: 0 }),
      );
      const usage = events().find((e) => e.type === 'usage_stats');
      expect(usage).to.not.equal(undefined);
      expect(Object.prototype.hasOwnProperty.call(usage, 'contextWindowTokens')).to.equal(false);
      rmSync(dir, { recursive: true });
    });

    it('does not emit usage_stats when no obsHandler is provided', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t6', 'Hello');
      const { sink, events } = fakeSink();
      const agent = stubAgent(null);
      await finalizeTurn(
        sink,
        store,
        agent,
        't6',
        'msg6',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      expect(events().some((e) => e.type === 'usage_stats')).to.equal(false);
      rmSync(dir, { recursive: true });
    });

    it('emits hitl_prompt with multiple_choice kind for recursion_limit_warning interrupt', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t7', 'Hello');
      const { sink, events } = fakeSink();
      const agent = stubAgent({
        kind: 'recursion_limit_warning',
        question: "I've been working for 75 LLM calls and want to check in.",
        choices: ['Continue working', 'Stop and summarize what you have done so far'],
        allowFreeText: true,
        stepsUsed: 75,
        recursionLimit: 100,
      });
      const result = await finalizeTurn(
        sink,
        store,
        agent,
        't7',
        'msg7',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      const emitted = events();
      const prompt = emitted.find((e) => e.type === 'hitl_prompt');
      expect(prompt, 'hitl_prompt event should be emitted').to.not.equal(undefined);
      expect(prompt?.kind).to.equal('multiple_choice');
      expect(prompt?.stepsUsed).to.equal(75);
      expect(prompt?.recursionLimit).to.equal(100);
      expect(prompt?.allowFreeText).to.equal(true);
      expect(prompt?.choices).to.be.an('array').with.length(2);
      expect(emitted.some((e) => e.type === 'stream_done')).to.equal(false);
      expect(result.interrupted).to.equal(true);
      rmSync(dir, { recursive: true });
    });

    it('persists the recursion_limit_warning prompt to thread_messages with multiple_choice promptKind', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t8', 'Hello');
      const { sink } = fakeSink();
      const agent = stubAgent({
        kind: 'recursion_limit_warning',
        question: "I've been working for 50 LLM calls.",
        choices: ['Continue working', 'Stop and summarize what you have done so far'],
        allowFreeText: true,
        stepsUsed: 50,
        recursionLimit: 100,
      });
      await finalizeTurn(
        sink,
        store,
        agent,
        't8',
        'msg8',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      const messages = store.getThreadMessages('t8', { showErrors: true });
      const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
      expect(hitlRow, 'hitl_prompt row should be written to thread_messages').to.not.equal(
        undefined,
      );
      expect((hitlRow?.payload as Record<string, unknown>)?.promptKind).to.equal('multiple_choice');
      expect((hitlRow?.payload as Record<string, unknown>)?.stepsUsed).to.equal(50);
      rmSync(dir, { recursive: true });
    });

    it('threads taskId into the persisted hitl_prompt payload when provided', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t9', 'Hello');
      const { sink } = fakeSink();
      const agent = stubAgent({
        kind: 'free_text',
        question: 'What should I call the new page?',
      });
      await finalizeTurn(
        sink,
        store,
        agent,
        't9',
        'msg9',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
        undefined,
        undefined,
        undefined,
        'task-123',
      );
      const messages = store.getThreadMessages('t9', { showErrors: true });
      const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
      expect((hitlRow?.payload as Record<string, unknown>)?.taskId).to.equal('task-123');
      rmSync(dir, { recursive: true });
    });

    it('omits taskId from the persisted hitl_prompt payload when not provided (regression guard)', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t10', 'Hello');
      const { sink } = fakeSink();
      const agent = stubAgent({
        kind: 'free_text',
        question: 'What should I call the new page?',
      });
      await finalizeTurn(
        sink,
        store,
        agent,
        't10',
        'msg10',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      const messages = store.getThreadMessages('t10', { showErrors: true });
      const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
      expect(
        Object.prototype.hasOwnProperty.call(hitlRow?.payload ?? {}, 'taskId'),
      ).to.equal(false);
      rmSync(dir, { recursive: true });
    });

    it('resolves interrupted:false when there is no interrupt', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t11', 'Hello');
      const { sink } = fakeSink();
      const agent = stubAgent(null);
      const result = await finalizeTurn(
        sink,
        store,
        agent,
        't11',
        'msg11',
        Date.now(),
        '',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      expect(result.interrupted).to.equal(false);
      rmSync(dir, { recursive: true });
    });
  });

  describe('pipeEvents', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('accumulates plain text deltas into the returned content, streamed as text_delta', async () => {
      const { sink, events } = fakeSink();
      const result = await pipeEvents(
        sink,
        'msg1',
        eventsFrom([
          { event: 'on_chat_model_stream', data: { chunk: { content: 'Hello' } } },
          { event: 'on_chat_model_stream', data: { chunk: { content: ' world' } } },
        ]),
        store,
        't1',
      );

      expect(result.content).to.equal('Hello world');
      expect(result.thoughtContent).to.equal('');
      // The safe-margin buffer (stream-handler.ts's SAFE_MARGIN) can split a
      // single logical delta across multiple text_delta events depending on
      // chunk boundaries — assert on the reconstructed whole, not exact
      // per-event chunking, which is an internal buffering detail.
      const allEvents = events();
      expect(allEvents.every((e) => e.type === 'text_delta')).to.equal(true);
      expect(allEvents.map((e) => e.delta as string).join('')).to.equal('Hello world');
    });

    it('separates <think>...</think> content into thoughtContent, not content', async () => {
      const { sink, events } = fakeSink();
      const result = await pipeEvents(
        sink,
        'msg2',
        eventsFrom([
          {
            event: 'on_chat_model_stream',
            data: { chunk: { content: 'Before <think>reasoning</think> after' } },
          },
        ]),
        store,
        't1',
      );

      expect(result.content).to.equal('Before  after');
      expect(result.thoughtContent).to.equal('reasoning');
      expect(events().map((e) => e.type)).to.deep.equal([
        'text_delta',
        'thought_delta',
        'text_delta',
      ]);
    });

    it('records a tool call start/end pair and finalizes with the right toolName/inputs/outputs', async () => {
      const { sink, events } = fakeSink();
      await pipeEvents(
        sink,
        'msg3',
        eventsFrom([
          {
            event: 'on_tool_start',
            name: 'add_numbers',
            run_id: 'tc1',
            data: { input: { a: 2, b: 3 } },
          },
          { event: 'on_tool_end', name: 'add_numbers', run_id: 'tc1', data: { output: '5' } },
        ]),
        store,
        't1',
      );

      const toolMsg = store.getMessage('t1', 'tc1')!;
      // The SSE tool_call_start event carries the row's real seq — not a
      // fork target itself, but populated for consistency with the DB truth
      // now that insertMessage's return value is threaded through.
      const startEvent = events().find((e) => e.type === 'tool_call_start')!;
      expect(startEvent.seq).to.equal(toolMsg.seq);
      expect(toolMsg.status).to.equal('done');
      expect(toolMsg.payload).to.deep.equal({
        toolCallId: 'tc1',
        toolName: 'add_numbers',
        inputs: { a: 2, b: 3 },
        outputs: '5',
      });
    });

    it('skips ask_user tool calls entirely — no SSE event, no thread_messages row', async () => {
      const { sink, events } = fakeSink();
      await pipeEvents(
        sink,
        'msg4',
        eventsFrom([
          { event: 'on_tool_start', name: 'ask_user', run_id: 'tc-ask', data: { input: {} } },
          { event: 'on_tool_end', name: 'ask_user', run_id: 'tc-ask', data: { output: 'yes' } },
        ]),
        store,
        't1',
      );

      expect(events()).to.deep.equal([]);
      expect(store.getMessage('t1', 'tc-ask')).to.equal(null);
    });

    it('emits and accumulates a final trailing delta on stream end (drainBuffer)', async () => {
      const { sink, events } = fakeSink();
      // The safe-margin buffering logic holds back the tail of a chunk in case
      // it's a split tag boundary — the final flush only happens once the
      // stream ends, via drainBuffer.
      const result = await pipeEvents(
        sink,
        'msg5',
        eventsFrom([{ event: 'on_chat_model_stream', data: { chunk: { content: 'hi' } } }]),
        store,
        't1',
      );
      expect(result.content).to.equal('hi');
      expect(events()).to.deep.equal([{ type: 'text_delta', messageId: 'msg5', delta: 'hi' }]);
    });
  });
});
