import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore } from '../services/thread-store.js';
import { pipeEvents, finalizeTurn, makeLiveSseWriter } from './stream-handler.js';

// A minimal fake Response — writeSseEvent() only ever calls res.write().
// Captures each raw SSE line so tests can assert on exactly what would have
// reached the client, alongside what landed in thread_messages.
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: () =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as Record<string, unknown>),
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
      const { res, events } = fakeRes();
      const agent = stubAgent({ kind: 'shell_approval', command: 'ls -la', reason: 'list' });
      await finalizeTurn(
        res,
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
      rmSync(dir, { recursive: true });
    });

    it('emits usage_stats before stream_done when obsHandler is provided', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t2', 'Hello');
      const { res, events } = fakeRes();
      const agent = stubAgent(null);
      await finalizeTurn(
        res,
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
      const { res, events } = fakeRes();
      const agent = stubAgent(null);
      await finalizeTurn(
        res,
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
      const { res, events } = fakeRes();
      const agent = stubAgent(null);
      await finalizeTurn(
        res,
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
      const { res, events } = fakeRes();
      const agent = stubAgent(null);
      await finalizeTurn(
        res,
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
      const { res, events } = fakeRes();
      const agent = stubAgent(null);
      await finalizeTurn(
        res,
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
      const { res, events } = fakeRes();
      const agent = stubAgent({
        kind: 'recursion_limit_warning',
        question: "I've been working for 75 LLM calls and want to check in.",
        choices: ['Continue working', 'Stop and summarize what you have done so far'],
        allowFreeText: true,
        stepsUsed: 75,
        recursionLimit: 100,
      });
      await finalizeTurn(
        res,
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
      rmSync(dir, { recursive: true });
    });

    it('persists the recursion_limit_warning prompt to thread_messages with multiple_choice promptKind', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t8', 'Hello');
      const { res } = fakeRes();
      const agent = stubAgent({
        kind: 'recursion_limit_warning',
        question: "I've been working for 50 LLM calls.",
        choices: ['Continue working', 'Stop and summarize what you have done so far'],
        allowFreeText: true,
        stepsUsed: 50,
        recursionLimit: 100,
      });
      await finalizeTurn(
        res,
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
      const { res, events } = fakeRes();
      const result = await pipeEvents(
        res,
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
      const { res, events } = fakeRes();
      const result = await pipeEvents(
        res,
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
      const { res, events } = fakeRes();
      await pipeEvents(
        res,
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
      const { res, events } = fakeRes();
      await pipeEvents(
        res,
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
      const { res, events } = fakeRes();
      // The safe-margin buffering logic holds back the tail of a chunk in case
      // it's a split tag boundary — the final flush only happens once the
      // stream ends, via drainBuffer.
      const result = await pipeEvents(
        res,
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
