import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import type { SpanRecord } from '@tkottke90/llm-common-types/traces';
import { ThreadStore } from '../../services/thread-store.js';
import { getScenarioSourceHandler } from './traces.handlers.js';

function makeStores(): { threadStore: ThreadStore; observabilityStore: ObservabilityStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'traces-handlers-test-'));
  const db: SqliteDatabase = openDatabase(join(dir, 'test.db'));
  return { threadStore: new ThreadStore(db), observabilityStore: new ObservabilityStore(db), dir };
}

function makeSpan(overrides: Partial<SpanRecord> & { spanId: string; traceId: string }): SpanRecord {
  return {
    parentSpanId: null,
    type: 'llm-call',
    name: 'llama3.2',
    startedAt: '2026-10-14T12:00:00.100Z',
    endedAt: '2026-10-14T12:00:01.000Z',
    latencyMs: 900,
    inputTokens: 10,
    outputTokens: 10,
    outputPreview: null,
    inputPreview: null,
    error: null,
    ...overrides,
  };
}

describe('getScenarioSourceHandler', () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it('returns 404 when the trace does not exist [unit]', () => {
    const { threadStore, observabilityStore, dir } = makeStores();
    dirs.push(dir);

    const result = getScenarioSourceHandler(observabilityStore, threadStore, 'missing-trace');

    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(404);
  });

  it('returns span-only, incomplete data when the trace has no linked thread [unit]', () => {
    const { threadStore, observabilityStore, dir } = makeStores();
    dirs.push(dir);

    const traceId = observabilityStore.startTrace({ provider: 'local', model: 'llama3.2', source: 'chat' });
    observabilityStore.saveSpans([
      makeSpan({ spanId: 'llm-1', traceId, outputPreview: 'Hi there.' }),
    ]);

    const result = getScenarioSourceHandler(observabilityStore, threadStore, traceId);

    expect(result.ok).to.equal(true);
    if (result.ok) {
      expect(result.data.threadId).to.equal(null);
      expect(result.data.incomplete).to.equal(true);
      expect(result.data.finalAssistantText).to.equal('Hi there.');
    }
  });

  it('joins the trace with the full, uncapped thread history — not the 200-message display cap [unit]', () => {
    const { threadStore, observabilityStore, dir } = makeStores();
    dirs.push(dir);

    const threadId = 'thread-1';
    threadStore.upsertThreadOnFirstMessage(threadId, 'test thread');
    // The real opening user turn is message #1 — everything after it is
    // filler pushing the thread past 200 messages, so a caller using
    // ThreadStore's default-capped getThreadMessages() would see this
    // message dropped (only the newest 200 survive that cap).
    threadStore.insertMessage(threadId, {
      id: 'msg-1',
      kind: 'user',
      payload: { content: 'Find the deploy steps', sentAt: '2026-10-14T11:59:59.000Z' },
    });
    for (let i = 0; i < 205; i++) {
      threadStore.insertMessage(threadId, {
        id: `filler-${i}`,
        kind: 'assistant',
        payload: { content: `filler ${i}`, sentAt: '2026-10-14T12:00:00.000Z' },
      });
    }
    threadStore.insertMessage(threadId, {
      id: 'tool-call-1',
      kind: 'tool_call',
      payload: {
        toolCallId: 'tool-call-1',
        toolName: 'wiki_search',
        inputs: { query: 'deploy steps' },
        outputs: { results: ['Deploy Notes'] },
      },
    });

    const traceId = observabilityStore.startTrace({
      threadId,
      provider: 'local',
      model: 'llama3.2',
      source: 'task-run',
    });
    observabilityStore.saveSpans([
      makeSpan({ spanId: 'llm-1', traceId, outputPreview: '[{"name":"wiki_search"}]' }),
      makeSpan({
        spanId: 'tool-1',
        traceId,
        type: 'tool-call',
        name: 'wiki_search',
        inputPreview: '{"query":"deploy steps"}',
        outputPreview: '(truncated preview)',
      }),
    ]);

    const result = getScenarioSourceHandler(observabilityStore, threadStore, traceId);

    expect(result.ok).to.equal(true);
    if (result.ok) {
      expect(result.data.turns[0]).to.deep.equal({ user: 'Find the deploy steps' });
      expect(result.data.turns[1]).to.deep.equal({
        tool: 'wiki_search',
        args: { query: 'deploy steps' },
        result: { results: ['Deploy Notes'] },
      });
      expect(result.data.incomplete).to.equal(false);
    }
  });
});
