import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { estimateTokens } from '@tkottke90/llm-common-types/tokens';
import { ObservabilityStore } from '@tkottke90/observability';
import { buildThreadReport } from '../../src/build.js';
import type {
  ThreadReportMessageRecord,
  ThreadReportThreadDetail,
  ThreadStoreLike,
} from '../../src/types.js';

function fakeThreadStore(thread: ThreadReportThreadDetail | null): ThreadStoreLike {
  return {
    getThread: () => thread,
  };
}

function makeThread(overrides: Partial<ThreadReportThreadDetail> = {}): ThreadReportThreadDetail {
  return {
    id: 't1',
    title: 'Test thread',
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:05:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    messages: [],
    ...overrides,
  };
}

// Used by the step-index/context-window test suites below, which construct
// many small synthetic message lists — a helper here cuts the boilerplate
// the other describe blocks in this file spell out fully inline.
function makeMessage(overrides: {
  id: string;
  seq: number;
  kind: string;
  payload: unknown;
  status?: string | null;
  retryOf?: string | null;
  threadId?: string;
}): ThreadReportMessageRecord {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? 't1',
    seq: overrides.seq,
    kind: overrides.kind,
    status: overrides.status ?? null,
    retryOf: overrides.retryOf ?? null,
    checkpointId: null,
    payload: overrides.payload,
    createdAt: `2026-07-18T10:00:${String(overrides.seq).padStart(2, '0')}.000Z`,
    updatedAt: `2026-07-18T10:00:${String(overrides.seq).padStart(2, '0')}.000Z`,
  };
}

describe('build/buildThreadReport', () => {
  let store: ObservabilityStore;
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'thread-reports-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new ObservabilityStore(db);
  });

  after(() => {
    rmSync(dir, { recursive: true });
  });

  it('returns null when the thread does not exist', () => {
    const result = buildThreadReport('missing', {
      threadStore: fakeThreadStore(null),
      observabilityStore: store,
    });
    expect(result).to.equal(null);
  });

  it('computes turn/tool-call/wiki-write counts and the most popular tool (ties broken alphabetically)', () => {
    const thread = makeThread({
      messages: [
        {
          id: 'u1',
          threadId: 't1',
          seq: 1,
          kind: 'user',
          status: null,
          retryOf: null,
          checkpointId: null,
          payload: { content: 'hi', sentAt: '2026-07-18T10:00:00.000Z' },
          createdAt: '2026-07-18T10:00:00.000Z',
          updatedAt: '2026-07-18T10:00:00.000Z',
        },
        {
          id: 'a1',
          threadId: 't1',
          seq: 2,
          kind: 'assistant',
          status: 'done',
          retryOf: null,
          checkpointId: null,
          payload: { content: 'hello', sentAt: '2026-07-18T10:00:01.000Z' },
          createdAt: '2026-07-18T10:00:01.000Z',
          updatedAt: '2026-07-18T10:00:01.000Z',
        },
        {
          id: 'tc1',
          threadId: 't1',
          seq: 3,
          kind: 'tool_call',
          status: 'done',
          retryOf: null,
          checkpointId: null,
          payload: { toolCallId: 'x', toolName: 'wiki_search', inputs: {} },
          createdAt: '2026-07-18T10:00:02.000Z',
          updatedAt: '2026-07-18T10:00:02.000Z',
        },
        {
          id: 'tc2',
          threadId: 't1',
          seq: 4,
          kind: 'tool_call',
          status: 'done',
          retryOf: null,
          checkpointId: null,
          payload: { toolCallId: 'y', toolName: 'ask_user', inputs: {} },
          createdAt: '2026-07-18T10:00:03.000Z',
          updatedAt: '2026-07-18T10:00:03.000Z',
        },
        {
          id: 'tc3',
          threadId: 't1',
          seq: 5,
          kind: 'tool_call',
          status: 'done',
          retryOf: null,
          checkpointId: null,
          payload: { toolCallId: 'z', toolName: 'ask_user', inputs: {} },
          createdAt: '2026-07-18T10:00:04.000Z',
          updatedAt: '2026-07-18T10:00:04.000Z',
        },
        {
          id: 'w1',
          threadId: 't1',
          seq: 6,
          kind: 'wiki_update',
          status: null,
          retryOf: null,
          checkpointId: null,
          payload: { pageTitle: 'Minecraft', pageKind: 'entity', wikiName: 'user' },
          createdAt: '2026-07-18T10:00:05.000Z',
          updatedAt: '2026-07-18T10:00:05.000Z',
        },
      ],
    });

    const result = buildThreadReport('t1', {
      threadStore: fakeThreadStore(thread),
      observabilityStore: store,
    });

    expect(result).to.not.equal(null);
    expect(result!.stats).to.deep.equal({
      turnCount: 1,
      toolCallCount: 3,
      mostPopularTool: 'ask_user',
      failureCount: 0,
      wikiWriteCount: 1,
    });
  });

  it('classifies AfterAgent traces as no-op, identified, or unknown, and counts span failures', () => {
    const threadId = 't2';

    const mainTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'chat',
    });
    store.saveSpans([
      {
        spanId: 'span-main-1',
        traceId: mainTraceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'llama3.2',
        startedAt: '2026-07-18T10:00:00.000Z',
        endedAt: '2026-07-18T10:00:01.000Z',
        latencyMs: 800,
        inputTokens: 50,
        outputTokens: 10,
        outputPreview: 'hi there',
        inputPreview: null,
        error: null,
      },
    ]);
    store.endTrace(mainTraceId, { totalTokens: 60 });

    const noOpTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'after-agent',
    });
    store.saveSpans([
      {
        spanId: 'span-noop-1',
        traceId: noOpTraceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'after-agent:summarize',
        startedAt: '2026-07-18T10:00:02.000Z',
        endedAt: '2026-07-18T10:00:02.400Z',
        latencyMs: 400,
        inputTokens: 30,
        outputTokens: 20,
        outputPreview: null,
        inputPreview: null,
        error: null,
      },
      {
        spanId: 'span-noop-2',
        traceId: noOpTraceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'after-agent:classify',
        startedAt: '2026-07-18T10:00:02.400Z',
        endedAt: '2026-07-18T10:00:02.700Z',
        latencyMs: 300,
        inputTokens: 20,
        outputTokens: 5,
        outputPreview: '{"shouldWrite":false}',
        inputPreview: null,
        error: null,
      },
    ]);
    store.endTrace(noOpTraceId, { totalTokens: 75 });

    const identifiedTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'after-agent',
    });
    store.saveSpans([
      {
        spanId: 'span-id-1',
        traceId: identifiedTraceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'after-agent:classify',
        startedAt: '2026-07-18T10:00:03.000Z',
        endedAt: '2026-07-18T10:00:03.300Z',
        latencyMs: 300,
        inputTokens: 20,
        outputTokens: 5,
        outputPreview: '{"shouldWrite":true}',
        inputPreview: null,
        error: null,
      },
      {
        spanId: 'span-id-2',
        traceId: identifiedTraceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'after-agent:extract',
        startedAt: '2026-07-18T10:00:03.300Z',
        endedAt: '2026-07-18T10:00:03.700Z',
        latencyMs: 400,
        inputTokens: 40,
        outputTokens: 60,
        outputPreview: null,
        inputPreview: null,
        error: 'boom: unknown domainId',
      },
    ]);
    store.endTrace(identifiedTraceId, { totalTokens: 125 });

    // Regression case: AfterAgent errors before its first LLM call completes
    // (e.g. createProvider() throwing) — startTrace()/endTrace() both run,
    // but zero spans are ever saved. Span-name inference alone is blind to
    // this (there's nothing to infer from); trace.source must carry it.
    const zeroSpanTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'after-agent',
    });
    store.endTrace(zeroSpanTraceId, { totalTokens: 0 });

    const thread = makeThread({ id: threadId, messages: [] });
    const result = buildThreadReport(threadId, {
      threadStore: fakeThreadStore(thread),
      observabilityStore: store,
    });

    expect(result).to.not.equal(null);
    expect(result!.timeline).to.have.lengthOf(4);

    // ObservabilityStore.startTrace() stamps real wall-clock time, so
    // synchronous calls can land in the same millisecond — look events up by
    // their traceId rather than relying on array position under such ties.
    const traceEvents = result!.timeline.filter((e) => e.kind === 'trace');
    const byTraceId = new Map(traceEvents.map((e) => [e.trace.traceId, e]));

    expect(byTraceId.get(mainTraceId)!.trace.source).to.equal('chat');
    expect(byTraceId.get(mainTraceId)).to.not.have.property('outcome');

    expect(byTraceId.get(noOpTraceId)).to.include({ kind: 'trace', outcome: 'no-op' });
    expect(byTraceId.get(noOpTraceId)!.trace.source).to.equal('after-agent');

    expect(byTraceId.get(identifiedTraceId)).to.include({ kind: 'trace', outcome: 'identified' });
    expect(byTraceId.get(identifiedTraceId)!.trace.source).to.equal('after-agent');

    expect(byTraceId.get(zeroSpanTraceId)).to.include({ kind: 'trace', outcome: 'unknown' });
    expect(byTraceId.get(zeroSpanTraceId)!.trace.source).to.equal('after-agent');
    expect(byTraceId.get(zeroSpanTraceId)!.trace.spans).to.have.lengthOf(0);

    // One span (the failed extract call) has a non-null error.
    expect(result!.stats.failureCount).to.equal(1);
  });

  it('interleaves wiki_update messages into the timeline in chronological order', () => {
    const threadId = 't3';
    const traceId = store.startTrace({ threadId, provider: 'local', model: 'llama3.2' });
    store.saveSpans([
      {
        spanId: 'span-t3-1',
        traceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'after-agent:extract',
        startedAt: '2026-07-18T09:00:00.000Z',
        endedAt: '2026-07-18T09:00:01.000Z',
        latencyMs: 1000,
        inputTokens: null,
        outputTokens: null,
        outputPreview: null,
        inputPreview: null,
        error: null,
      },
      {
        spanId: 'span-t3-2',
        traceId,
        parentSpanId: null,
        type: 'llm-call',
        name: 'after-agent:classify',
        startedAt: '2026-07-18T09:00:01.000Z',
        endedAt: '2026-07-18T09:00:02.000Z',
        latencyMs: 1000,
        inputTokens: null,
        outputTokens: null,
        outputPreview: null,
        inputPreview: null,
        error: null,
      },
    ]);
    store.endTrace(traceId, { totalTokens: 0 });

    // startTrace() stamps startedAt with the real wall-clock time (not
    // something a test can inject), so the wiki_update's timestamp must be
    // derived from the trace's actual recorded time, not a fixed fixture date.
    const traceStartedAt = store.getTrace(traceId)!.startedAt;
    const wikiUpdateAt = new Date(new Date(traceStartedAt).getTime() + 5000).toISOString();

    const thread = makeThread({
      id: threadId,
      messages: [
        {
          id: 'w1',
          threadId,
          seq: 1,
          kind: 'wiki_update',
          status: null,
          retryOf: null,
          checkpointId: null,
          payload: { pageTitle: 'Minecraft', pageKind: 'entity', wikiName: 'user' },
          createdAt: wikiUpdateAt,
          updatedAt: wikiUpdateAt,
        },
      ],
    });

    const result = buildThreadReport(threadId, {
      threadStore: fakeThreadStore(thread),
      observabilityStore: store,
    });

    expect(result!.timeline.map((e) => e.kind)).to.deep.equal(['trace', 'wiki_update']);
  });

  it('attaches the triggering user message to chat traces, but not to after-agent/generate-title traces', () => {
    const threadId = 't4';

    const chatTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'chat',
    });
    store.endTrace(chatTraceId, { totalTokens: 0 });
    const chatTraceStartedAt = store.getTrace(chatTraceId)!.startedAt;

    const afterAgentTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'after-agent',
    });
    store.endTrace(afterAgentTraceId, { totalTokens: 0 });

    // Two user messages: one clearly before the chat trace (the one that
    // should be picked), one clearly after (must NOT be picked — a trace
    // can't be triggered by a message that hadn't been sent yet).
    const before = new Date(new Date(chatTraceStartedAt).getTime() - 5000).toISOString();
    const after = new Date(new Date(chatTraceStartedAt).getTime() + 5000).toISOString();

    const thread = makeThread({
      id: threadId,
      messages: [
        {
          id: 'u1',
          threadId,
          seq: 1,
          kind: 'user',
          status: null,
          retryOf: null,
          checkpointId: null,
          payload: { content: 'I like Minecraft', sentAt: before },
          createdAt: before,
          updatedAt: before,
        },
        {
          id: 'u2',
          threadId,
          seq: 2,
          kind: 'user',
          status: null,
          retryOf: null,
          checkpointId: null,
          payload: { content: 'A later, unrelated message', sentAt: after },
          createdAt: after,
          updatedAt: after,
        },
      ],
    });

    const result = buildThreadReport(threadId, {
      threadStore: fakeThreadStore(thread),
      observabilityStore: store,
    });

    const byTraceId = new Map(
      result!.timeline.filter((e) => e.kind === 'trace').map((e) => [e.trace.traceId, e]),
    );

    expect(byTraceId.get(chatTraceId)!.userMessage?.id).to.equal('u1');
    expect(byTraceId.get(afterAgentTraceId)!.userMessage).to.equal(undefined);
  });

  it('passes trace.systemPrompt through unchanged, present or absent', () => {
    const threadId = 't5';

    const chatTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'chat',
      systemPrompt: 'You have no built-in memory of this specific user.',
    });
    store.endTrace(chatTraceId, { totalTokens: 0 });

    const afterAgentTraceId = store.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'after-agent',
    });
    store.endTrace(afterAgentTraceId, { totalTokens: 0 });

    const thread = makeThread({ id: threadId, messages: [] });
    const result = buildThreadReport(threadId, {
      threadStore: fakeThreadStore(thread),
      observabilityStore: store,
    });

    const byTraceId = new Map(
      result!.timeline.filter((e) => e.kind === 'trace').map((e) => [e.trace.traceId, e]),
    );

    expect(byTraceId.get(chatTraceId)!.trace.systemPrompt).to.equal(
      'You have no built-in memory of this specific user.',
    );
    expect(byTraceId.get(afterAgentTraceId)!.trace.systemPrompt).to.equal(null);
  });

  describe('step index', () => {
    it('gives a single assistant message stepIndex 1', () => {
      const thread = makeThread({
        id: 't10',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'hi', sentAt: '' } }),
          makeMessage({
            id: 'a1',
            seq: 2,
            kind: 'assistant',
            payload: { content: 'hello', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport('t10', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      const assistant = result!.thread.messages.find((m) => m.id === 'a1');
      expect(assistant!.stepIndex).to.equal(1);
    });

    it('increments only on assistant messages across multiple tool-calling loops in one turn', () => {
      const thread = makeThread({
        id: 't11',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'go', sentAt: '' } }),
          makeMessage({
            id: 'a1',
            seq: 2,
            kind: 'assistant',
            payload: { content: '', sentAt: '' },
          }),
          makeMessage({
            id: 'tc1',
            seq: 3,
            kind: 'tool_call',
            payload: { toolCallId: 'x', toolName: 'wiki_search', inputs: {} },
          }),
          makeMessage({
            id: 'tc2',
            seq: 4,
            kind: 'tool_call',
            payload: { toolCallId: 'y', toolName: 'wiki_search', inputs: {} },
          }),
          makeMessage({
            id: 'a2',
            seq: 5,
            kind: 'assistant',
            payload: { content: '', sentAt: '' },
          }),
          makeMessage({
            id: 'tc3',
            seq: 6,
            kind: 'tool_call',
            payload: { toolCallId: 'z', toolName: 'wiki_search', inputs: {} },
          }),
          makeMessage({
            id: 'a3',
            seq: 7,
            kind: 'assistant',
            payload: { content: 'done', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport('t11', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      const byId = new Map(result!.thread.messages.map((m) => [m.id, m]));
      expect(byId.get('a1')!.stepIndex).to.equal(1);
      expect(byId.get('a2')!.stepIndex).to.equal(2);
      expect(byId.get('a3')!.stepIndex).to.equal(3);
      expect(byId.get('tc1')!.stepIndex).to.equal(undefined);
      expect(byId.get('u1')!.stepIndex).to.equal(undefined);
    });

    it('gives a retried assistant message its own incremented stepIndex', () => {
      const thread = makeThread({
        id: 't12',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'go', sentAt: '' } }),
          makeMessage({
            id: 'a1',
            seq: 2,
            kind: 'assistant',
            status: 'error',
            payload: { content: '', sentAt: '' },
          }),
          makeMessage({
            id: 'a1-retry',
            seq: 3,
            kind: 'assistant',
            retryOf: 'a1',
            payload: { content: 'retry result', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport('t12', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      const byId = new Map(result!.thread.messages.map((m) => [m.id, m]));
      expect(byId.get('a1')!.stepIndex).to.equal(1);
      expect(byId.get('a1-retry')!.stepIndex).to.equal(2);
    });
  });

  describe('context window budget walk', () => {
    it('reports nothing trimmed when the full history fits in the budget', () => {
      const thread = makeThread({
        id: 't20',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'aaaa', sentAt: '' } }),
          makeMessage({
            id: 'a1',
            seq: 2,
            kind: 'assistant',
            payload: { content: 'bbbb', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport(
        't20',
        { threadStore: fakeThreadStore(thread), observabilityStore: store },
        { contextWindowMaxTokens: 1000 },
      );

      expect(result!.contextWindow).to.deep.equal({
        totalContextTokens: 2,
        activeContextTokens: 2,
        contextWindowMaxTokens: 1000,
        boundaryMessageId: null,
      });
    });

    it('trims the oldest messages and reports the boundary when the budget is exceeded', () => {
      // Each message is 4 chars -> 1 token via estimateTokens.
      const thread = makeThread({
        id: 't21',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'aaaa', sentAt: '' } }),
          makeMessage({
            id: 'a1',
            seq: 2,
            kind: 'assistant',
            payload: { content: 'bbbb', sentAt: '' },
          }),
          makeMessage({ id: 'u2', seq: 3, kind: 'user', payload: { content: 'cccc', sentAt: '' } }),
          makeMessage({
            id: 'a2',
            seq: 4,
            kind: 'assistant',
            payload: { content: 'dddd', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport(
        't21',
        { threadStore: fakeThreadStore(thread), observabilityStore: store },
        { contextWindowMaxTokens: 2 },
      );

      expect(result!.contextWindow).to.deep.equal({
        totalContextTokens: 4,
        activeContextTokens: 2,
        contextWindowMaxTokens: 2,
        boundaryMessageId: 'u2',
      });
    });

    it('keeps a message whose inclusion lands the running total exactly on the budget', () => {
      // u0/a0 = 1 token each (older, expected to be dropped), u1/a1 = 2
      // tokens each (newer). maxTokens=4 lands exactly after including u1,
      // which must be kept, not excluded, by the strictly-greater-than check.
      const thread = makeThread({
        id: 't22',
        messages: [
          makeMessage({ id: 'u0', seq: 1, kind: 'user', payload: { content: 'aaaa', sentAt: '' } }),
          makeMessage({
            id: 'a0',
            seq: 2,
            kind: 'assistant',
            payload: { content: 'bbbb', sentAt: '' },
          }),
          makeMessage({
            id: 'u1',
            seq: 3,
            kind: 'user',
            payload: { content: 'cccccccc', sentAt: '' },
          }),
          makeMessage({
            id: 'a1',
            seq: 4,
            kind: 'assistant',
            payload: { content: 'dddddddd', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport(
        't22',
        { threadStore: fakeThreadStore(thread), observabilityStore: store },
        { contextWindowMaxTokens: 4 },
      );

      expect(result!.contextWindow).to.deep.equal({
        totalContextTokens: 6,
        activeContextTokens: 4,
        contextWindowMaxTokens: 4,
        boundaryMessageId: 'u1',
      });
    });

    it('omits contextWindow when the thread has no countable messages', () => {
      const emptyThread = makeThread({ id: 't23', messages: [] });
      const emptyResult = buildThreadReport('t23', {
        threadStore: fakeThreadStore(emptyThread),
        observabilityStore: store,
      });
      expect(emptyResult!.contextWindow).to.equal(undefined);

      const onlySideChannelThread = makeThread({
        id: 't24',
        messages: [
          makeMessage({
            id: 'h1',
            seq: 1,
            kind: 'hitl_prompt',
            payload: { promptId: 'h1', question: 'Continue?', kind: 'yes_no' },
          }),
          makeMessage({
            id: 'w1',
            seq: 2,
            kind: 'wiki_update',
            payload: { pageTitle: 'X', pageKind: 'entity', wikiName: 'user' },
          }),
        ],
      });
      const sideChannelResult = buildThreadReport('t24', {
        threadStore: fakeThreadStore(onlySideChannelThread),
        observabilityStore: store,
      });
      expect(sideChannelResult!.contextWindow).to.equal(undefined);
    });

    it('counts both inputs and outputs of a tool_call message', () => {
      const inputs = { query: 'x'.repeat(40) };
      const outputs = { result: 'y'.repeat(40) };
      const thread = makeThread({
        id: 't25',
        messages: [
          makeMessage({
            id: 'tc1',
            seq: 1,
            kind: 'tool_call',
            payload: { toolCallId: 'x', toolName: 'wiki_search', inputs, outputs },
          }),
        ],
      });

      const result = buildThreadReport('t25', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      const expectedTokens = estimateTokens(
        `${JSON.stringify(inputs)}\n${JSON.stringify(outputs)}`,
      );
      expect(result!.contextWindow!.totalContextTokens).to.equal(expectedTokens);
    });

    it('includes summary-kind messages in the walk', () => {
      const content = 'This thread summarizes a long conversation about wiki tuning.';
      const thread = makeThread({
        id: 't26',
        messages: [
          makeMessage({
            id: 's1',
            seq: 1,
            kind: 'summary',
            payload: { content, summaryPath: '/wiki/thread-t26-summary.md' },
          }),
        ],
      });

      const result = buildThreadReport('t26', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      expect(result!.contextWindow!.totalContextTokens).to.equal(estimateTokens(content));
    });

    it('excludes hitl_prompt, wiki_update, resource_card, and task_run_marker from totals and stepping', () => {
      const thread = makeThread({
        id: 't27',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'aaaa', sentAt: '' } }),
          makeMessage({
            id: 'h1',
            seq: 2,
            kind: 'hitl_prompt',
            payload: { promptId: 'h1', question: 'Continue?', kind: 'yes_no' },
          }),
          makeMessage({
            id: 'w1',
            seq: 3,
            kind: 'wiki_update',
            payload: { pageTitle: 'X', pageKind: 'entity', wikiName: 'user' },
          }),
          makeMessage({
            id: 'r1',
            seq: 4,
            kind: 'resource_card',
            payload: { resourceType: 'workspace', name: 'X', location: '/x', workspaceId: 'w' },
          }),
          makeMessage({
            id: 't1',
            seq: 5,
            kind: 'task_run_marker',
            payload: { taskId: 'task1', taskTitle: 'X', phase: 'start' },
          }),
        ],
      });

      const result = buildThreadReport('t27', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      expect(result!.contextWindow!.totalContextTokens).to.equal(estimateTokens('aaaa'));
      expect(result!.contextWindow!.activeContextTokens).to.equal(estimateTokens('aaaa'));
    });

    it('advances a tentative cutoff landing mid-tool_call forward to the nearest user message', () => {
      // All messages 4 chars -> 1 token each. maxTokens=3 tentatively keeps
      // a2, u2, tc1 (3 tokens) before the startOn:'human' correction — tc1
      // is not a user message, so the correction must push the kept tail
      // forward to u2, dropping tc1 (and a1) from Active even though tc1's
      // inclusion didn't exceed the raw budget.
      const thread = makeThread({
        id: 't28',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'aaaa', sentAt: '' } }),
          makeMessage({
            id: 'a1',
            seq: 2,
            kind: 'assistant',
            payload: { content: 'bbbb', sentAt: '' },
          }),
          makeMessage({
            id: 'tc1',
            // inputs/outputs chosen so this message's estimated size is
            // exactly 1 token too — see the header comment above.
            seq: 3,
            kind: 'tool_call',
            payload: { toolCallId: 'x', toolName: 'wiki_search', inputs: 0, outputs: 0 },
          }),
          makeMessage({ id: 'u2', seq: 4, kind: 'user', payload: { content: 'cccc', sentAt: '' } }),
          makeMessage({
            id: 'a2',
            seq: 5,
            kind: 'assistant',
            payload: { content: 'dddd', sentAt: '' },
          }),
        ],
      });

      const result = buildThreadReport(
        't28',
        { threadStore: fakeThreadStore(thread), observabilityStore: store },
        { contextWindowMaxTokens: 3 },
      );

      expect(result!.contextWindow).to.deep.equal({
        totalContextTokens: 5,
        activeContextTokens: 2,
        contextWindowMaxTokens: 3,
        boundaryMessageId: 'u2',
      });
    });
  });

  describe('system prompt tokens', () => {
    it('computes systemPromptTokens from trace.systemPrompt when present', () => {
      const threadId = 't30';
      const systemPrompt = 'You are a helpful assistant with access to the wiki.';
      const traceId = store.startTrace({
        threadId,
        provider: 'local',
        model: 'llama3.2',
        source: 'chat',
        systemPrompt,
      });
      store.endTrace(traceId, { totalTokens: 0 });

      const thread = makeThread({ id: threadId, messages: [] });
      const result = buildThreadReport(threadId, {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      const event = result!.timeline.find((e) => e.kind === 'trace' && e.trace.traceId === traceId);
      expect(event).to.not.equal(undefined);
      expect((event as { systemPromptTokens: number | null }).systemPromptTokens).to.equal(
        estimateTokens(systemPrompt),
      );
    });

    it('gives systemPromptTokens null when trace.systemPrompt is null', () => {
      const threadId = 't31';
      const traceId = store.startTrace({
        threadId,
        provider: 'local',
        model: 'llama3.2',
        source: 'after-agent',
      });
      store.endTrace(traceId, { totalTokens: 0 });

      const thread = makeThread({ id: threadId, messages: [] });
      const result = buildThreadReport(threadId, {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      const event = result!.timeline.find((e) => e.kind === 'trace' && e.trace.traceId === traceId);
      expect((event as { systemPromptTokens: number | null }).systemPromptTokens).to.equal(null);
    });
  });

  describe('options defaults', () => {
    it('defaults recursion info to recursionLimit 100 / recursionWarnThreshold 0.75 when omitted', () => {
      const thread = makeThread({ id: 't40', messages: [] });
      const result = buildThreadReport('t40', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      expect(result!.recursion).to.deep.equal({
        recursionLimit: 100,
        recursionWarnThreshold: 0.75,
      });
    });

    it('reflects explicit recursion overrides when passed', () => {
      const thread = makeThread({ id: 't41', messages: [] });
      const result = buildThreadReport(
        't41',
        { threadStore: fakeThreadStore(thread), observabilityStore: store },
        { recursionLimit: 50, recursionWarnThreshold: 0.5 },
      );

      expect(result!.recursion).to.deep.equal({ recursionLimit: 50, recursionWarnThreshold: 0.5 });
    });

    it('defaults contextWindowMaxTokens to 32000 when omitted', () => {
      const thread = makeThread({
        id: 't42',
        messages: [
          makeMessage({ id: 'u1', seq: 1, kind: 'user', payload: { content: 'aaaa', sentAt: '' } }),
        ],
      });
      const result = buildThreadReport('t42', {
        threadStore: fakeThreadStore(thread),
        observabilityStore: store,
      });

      expect(result!.contextWindow!.contextWindowMaxTokens).to.equal(32000);
    });
  });
});
