import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import { buildThreadReport } from '../../src/build.js';
import type { ThreadReportThreadDetail, ThreadStoreLike } from '../../src/types.js';

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

    const mainTraceId = store.startTrace({ threadId, provider: 'local', model: 'llama3.2' });
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

    const noOpTraceId = store.startTrace({ threadId, provider: 'local', model: 'llama3.2' });
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

    const identifiedTraceId = store.startTrace({ threadId, provider: 'local', model: 'llama3.2' });
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

    const thread = makeThread({ id: threadId, messages: [] });
    const result = buildThreadReport(threadId, {
      threadStore: fakeThreadStore(thread),
      observabilityStore: store,
    });

    expect(result).to.not.equal(null);
    expect(result!.timeline).to.have.lengthOf(3);

    // ObservabilityStore.startTrace() stamps real wall-clock time, so three
    // synchronous calls can land in the same millisecond — look events up by
    // their traceId rather than relying on array position under such ties.
    const traceEvents = result!.timeline.filter((e) => e.kind === 'trace');
    const byTraceId = new Map(traceEvents.map((e) => [e.trace.traceId, e]));

    expect(byTraceId.get(mainTraceId)).to.include({ kind: 'trace', source: 'main-turn' });
    expect(byTraceId.get(noOpTraceId)).to.include({
      kind: 'trace',
      source: 'after-agent',
      outcome: 'no-op',
    });
    expect(byTraceId.get(identifiedTraceId)).to.include({
      kind: 'trace',
      source: 'after-agent',
      outcome: 'identified',
    });

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
});
