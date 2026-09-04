import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { ToolMessage } from '@langchain/core/messages';
import { ThreadStore } from '../services/thread-store.js';
import {
  pipeEvents,
  finalizeTurn,
  makeLiveSseWriter,
  PipeEventsError,
  extractPartialAssistantState,
  drainAndRecordWikiUpdates,
  resolveAttachmentForTurn,
} from './stream-handler.js';
import { recordAssistantStart } from './thread-message-writer.js';
import { queueWikiUpdate } from './after-agent.js';
import { bootArtifactStore, storeArtifact } from '../artifacts/artifact-store.js';

const TEST_SENT_AT = '2024-01-01T00:00:00.000Z';

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

    it('persists durationMs/usage/cost onto the finalized row when obsHandler is provided', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t8', 'Hello');
      recordAssistantStart(store, 't8', 'msg8', new Date().toISOString());
      const { sink } = fakeSink();
      const agent = stubAgent(null);
      const startedAt = Date.now() - 500;
      await finalizeTurn(
        sink,
        store,
        agent,
        't8',
        'msg8',
        startedAt,
        'final content',
        '',
        new Date().toISOString(),
        null,
        null,
        stubObsHandler({
          totalInputTokens: 512,
          totalOutputTokens: 128,
          turnDurationMs: 2000,
        }),
      );
      const persisted = store.getMessage('t8', 'msg8');
      const payload = persisted!.payload as Record<string, unknown>;
      expect(payload.durationMs).to.be.a('number');
      expect(payload.durationMs as number).to.be.at.least(500);
      expect(payload.usage).to.deep.equal({ inputTokens: 512, outputTokens: 128 });
      expect(payload.cost).to.deep.equal({ tokensPerSecond: 64 }); // 128 tokens / 2s = 64 tok/s, no cost rate configured
      rmSync(dir, { recursive: true });
    });

    it('omits durationMs/usage/cost from the persisted row when no obsHandler is provided (task-run parity)', async () => {
      const { store, dir } = makeStore();
      store.upsertThreadOnFirstMessage('t9', 'Hello');
      recordAssistantStart(store, 't9', 'msg9', new Date().toISOString());
      const { sink } = fakeSink();
      const agent = stubAgent(null);
      await finalizeTurn(
        sink,
        store,
        agent,
        't9',
        'msg9',
        Date.now(),
        'final content',
        '',
        new Date().toISOString(),
        null,
        null,
      );
      const persisted = store.getMessage('t9', 'msg9');
      const payload = persisted!.payload as Record<string, unknown>;
      expect(payload.durationMs).to.equal(undefined);
      expect(payload.usage).to.equal(undefined);
      expect(payload.cost).to.equal(undefined);
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
      const messages = store.getThreadMessages('t8');
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
      const messages = store.getThreadMessages('t9');
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
      const messages = store.getThreadMessages('t10');
      const hitlRow = messages.find((m) => m.kind === 'hitl_prompt');
      expect(Object.prototype.hasOwnProperty.call(hitlRow?.payload ?? {}, 'taskId')).to.equal(
        false,
      );
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
        TEST_SENT_AT,
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
        TEST_SENT_AT,
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
        TEST_SENT_AT,
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

    it('unwraps a LangChain ToolMessage output to its plain content in both the DB payload and the SSE event', async () => {
      const { sink, events } = fakeSink();
      const toolMessage = new ToolMessage({
        content: 'Added cross-link from entities/wireguard.md to entities/windows-pc.md.',
        tool_call_id: 'tc-link',
        name: 'wiki_add_cross_link',
      });
      await pipeEvents(
        sink,
        'msg3b',
        eventsFrom([
          {
            event: 'on_tool_start',
            name: 'wiki_add_cross_link',
            run_id: 'tc-link',
            data: { input: { fromPage: 'a.md', toPage: 'b.md' } },
          },
          {
            event: 'on_tool_end',
            name: 'wiki_add_cross_link',
            run_id: 'tc-link',
            data: { output: toolMessage },
          },
        ]),
        store,
        't1',
        TEST_SENT_AT,
      );

      const toolMsg = store.getMessage('t1', 'tc-link')!;
      expect(toolMsg.payload).to.deep.equal({
        toolCallId: 'tc-link',
        toolName: 'wiki_add_cross_link',
        inputs: { fromPage: 'a.md', toPage: 'b.md' },
        outputs: 'Added cross-link from entities/wireguard.md to entities/windows-pc.md.',
      });

      const endEvent = events().find((e) => e.type === 'tool_call_end')!;
      expect(endEvent.outputs).to.equal(
        'Added cross-link from entities/wireguard.md to entities/windows-pc.md.',
      );
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
        TEST_SENT_AT,
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
        TEST_SENT_AT,
      );
      expect(result.content).to.equal('hi');
      expect(events()).to.deep.equal([{ type: 'text_delta', messageId: 'msg5', delta: 'hi' }]);
    });

    it('splits into a new assistant row when text resumes after a mid-turn tool call', async () => {
      recordAssistantStart(store, 't1', 'msg6', TEST_SENT_AT);
      const { sink, events } = fakeSink();
      const result = await pipeEvents(
        sink,
        'msg6',
        eventsFrom([
          { event: 'on_chat_model_stream', data: { chunk: { content: 'Checking the weather.' } } },
          {
            event: 'on_tool_start',
            name: 'get_weather',
            run_id: 'tc-weather',
            data: { input: {} },
          },
          {
            event: 'on_tool_end',
            name: 'get_weather',
            run_id: 'tc-weather',
            data: { output: 'sunny' },
          },
          { event: 'on_chat_model_stream', data: { chunk: { content: 'It is sunny today.' } } },
        ]),
        store,
        't1',
        TEST_SENT_AT,
      );

      // A new segment row was opened for the text that followed the tool call.
      expect(result.finalSegmentId).to.not.equal('msg6');
      expect(result.content).to.equal('It is sunny today.');

      const firstSegment = store.getMessage('t1', 'msg6')!;
      expect(firstSegment.status).to.equal('done');
      expect((firstSegment.payload as { content: string }).content).to.equal(
        'Checking the weather.',
      );

      // pipeEvents only opens the trailing segment's row — finalizing it with
      // the real content is finalizeTurn's job once the whole turn ends, same
      // as it always was for a single-segment turn.
      const secondSegment = store.getMessage('t1', result.finalSegmentId)!;
      expect(secondSegment.status).to.equal('streaming');

      // The tool call's own row sits between the two assistant segments in
      // seq order, matching what actually happened live.
      const toolMsg = store.getMessage('t1', 'tc-weather')!;
      expect(firstSegment.seq).to.be.lessThan(toolMsg.seq);
      expect(toolMsg.seq).to.be.lessThan(secondSegment.seq);

      // The live SSE stream reflects the same split via messageId.
      const textDeltas = events().filter((e) => e.type === 'text_delta');
      expect(textDeltas[0]!.messageId).to.equal('msg6');
      expect(textDeltas[textDeltas.length - 1]!.messageId).to.equal(result.finalSegmentId);
    });

    it('does not split when a tool call fires before any text has arrived', async () => {
      recordAssistantStart(store, 't1', 'msg6b', TEST_SENT_AT);
      const { sink } = fakeSink();
      const result = await pipeEvents(
        sink,
        'msg6b',
        eventsFrom([
          { event: 'on_tool_start', name: 'get_time', run_id: 'tc-time', data: { input: {} } },
          { event: 'on_tool_end', name: 'get_time', run_id: 'tc-time', data: { output: 'noon' } },
          { event: 'on_chat_model_stream', data: { chunk: { content: "It's noon." } } },
        ]),
        store,
        't1',
        TEST_SENT_AT,
      );

      // Still-empty segment when the tool call fired — nothing to split yet,
      // so the trailing text keeps filling the original row in place.
      expect(result.finalSegmentId).to.equal('msg6b');
      expect(result.content).to.equal("It's noon.");
    });

    it('wraps a mid-stream failure in PipeEventsError carrying the in-flight segment id and partial content', async () => {
      recordAssistantStart(store, 't1', 'msg7', TEST_SENT_AT);
      const { sink } = fakeSink();
      const longChunk = 'This is a longer partial response than the safe margin holds back';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function* throwingStream(): AsyncGenerator<any> {
        yield { event: 'on_chat_model_stream', data: { chunk: { content: longChunk } } };
        throw new Error('boom');
      }

      let caught: unknown;
      try {
        await pipeEvents(sink, 'msg7', throwingStream(), store, 't1', TEST_SENT_AT);
      } catch (err) {
        caught = err;
      }

      expect(caught).to.be.instanceOf(PipeEventsError);
      const err = caught as PipeEventsError;
      expect(err.segmentId).to.equal('msg7');
      expect(err.partialContent.length).to.be.greaterThan(0);
      expect(longChunk.startsWith(err.partialContent)).to.equal(true);

      const recovered = extractPartialAssistantState(err, 'msg7');
      expect(recovered.segmentId).to.equal('msg7');
      expect(recovered.content).to.equal(err.partialContent);
    });

    it('extractPartialAssistantState falls back to the given id and empty content for a non-PipeEventsError', () => {
      const recovered = extractPartialAssistantState(new Error('unrelated'), 'msg8');
      expect(recovered).to.deep.equal({ segmentId: 'msg8', content: '', thoughtContent: '' });
    });
  });

  describe('drainAndRecordWikiUpdates', () => {
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

    it('forwards a queued wiki_updated event to the sink and persists it with path', () => {
      queueWikiUpdate('t1', {
        type: 'wiki_updated',
        pageTitle: 'Router',
        pageKind: 'created',
        wikiName: 'homelab',
        path: 'entities/router.md',
      });

      const { sink, events } = fakeSink();
      drainAndRecordWikiUpdates(sink, store, 't1');

      expect(events()).to.have.length(1);
      expect(events()[0]).to.deep.include({
        type: 'wiki_updated',
        pageTitle: 'Router',
        pageKind: 'created',
        wikiName: 'homelab',
        path: 'entities/router.md',
      });

      const messages = store.getThreadMessages('t1');
      const wikiUpdateRow = messages.find((m) => m.kind === 'wiki_update')!;
      expect(wikiUpdateRow.payload).to.deep.equal({
        pageTitle: 'Router',
        pageKind: 'created',
        wikiName: 'homelab',
        path: 'entities/router.md',
      });
    });
  });

  describe('resolveAttachmentForTurn', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'stream-handler-attachment-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('passes plain content through unchanged when no attachmentId is given', async () => {
      const result = await resolveAttachmentForTurn(undefined, 'hello', 'p', 'm');
      expect(result).to.deep.equal({ llmContent: 'hello', record: undefined });
    });

    it('passes plain content through unchanged for an unknown attachmentId', async () => {
      const result = await resolveAttachmentForTurn('nonexistent', 'hello', 'p', 'm');
      expect(result).to.deep.equal({ llmContent: 'hello', record: undefined });
    });

    it('excludes a vision-required attachment when the model lacks vision support', async () => {
      const id = await storeArtifact({
        mimeType: 'image/png',
        original: Buffer.from('fake-image-bytes'),
        displayFilename: 'photo.png',
        requiresVision: true,
      });

      const result = await resolveAttachmentForTurn(
        id,
        'look at this',
        'p',
        'm',
        async () => false,
      );

      expect(result.llmContent).to.equal('look at this');
      expect(result.record).to.deep.equal({
        id,
        filename: 'photo.png',
        mimeType: 'image/png',
        included: false,
      });
    });

    it('builds a multimodal content block for a vision-required attachment when the model supports vision', async () => {
      const original = Buffer.from('fake-image-bytes');
      const id = await storeArtifact({
        mimeType: 'image/png',
        original,
        displayFilename: 'photo.png',
        requiresVision: true,
      });

      const result = await resolveAttachmentForTurn(id, 'look at this', 'p', 'm', async () => true);

      expect(result.llmContent).to.deep.equal([
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', data: original.toString('base64') },
      ]);
      expect(result.record).to.deep.equal({
        id,
        filename: 'photo.png',
        mimeType: 'image/png',
        included: true,
      });
    });

    it('merges extracted text for a document attachment without ever checking vision capability', async () => {
      const id = await storeArtifact({
        mimeType: 'text/plain',
        original: Buffer.from('the doc bytes'),
        displayFilename: 'notes.txt',
        requiresVision: false,
        extractedText: 'the extracted notes',
      });

      let checkVisionCalled = false;
      const result = await resolveAttachmentForTurn(id, 'here is a doc', 'p', 'm', async () => {
        checkVisionCalled = true;
        return false;
      });

      expect(checkVisionCalled).to.equal(false);
      expect(result.llmContent).to.equal(
        'here is a doc\n\n---\nAttached file "notes.txt":\nthe extracted notes',
      );
      expect(result.record).to.deep.equal({
        id,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        included: true,
      });
    });
  });
});
