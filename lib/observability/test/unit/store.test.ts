import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { ObservabilityStore } from '../../src/store.js';
import type { SpanRecord } from '../../src/index.js';

function makeStore(): { store: ObservabilityStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'obs-test-'));
  const store = ObservabilityStore.open(join(dir, 'test.db'));
  return { store, dir };
}

function makeSpan(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    spanId: crypto.randomUUID(),
    traceId: 'trace-1',
    parentSpanId: null,
    type: 'llm-call',
    name: 'gpt-4o',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    latencyMs: 120,
    inputTokens: 50,
    outputTokens: 30,
    outputPreview: 'hello',
    inputPreview: null,
    error: null,
    ...overrides,
  };
}

describe('ObservabilityStore', () => {
  describe('startTrace / findById', () => {
    let store: ObservabilityStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('creates a trace row and returns it via findById', () => {
      const traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });
      const summary = store.findById(traceId);
      assert.ok(summary);
      assert.equal(summary.traceId, traceId);
      assert.equal(summary.provider, 'openai');
      assert.equal(summary.model, 'gpt-4o');
      assert.equal(summary.totalTokens, 0);
      assert.equal(summary.endedAt, null);
      assert.equal(summary.spanCount, 0);
    });

    it('returns null for an unknown traceId', () => {
      assert.equal(store.findById('no-such-id'), null);
    });
  });

  describe('endTrace', () => {
    let store: ObservabilityStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('updates ended_at, total_tokens, total_cost_estimate', () => {
      const traceId = store.startTrace({ provider: 'anthropic', model: 'claude-3-5' });
      store.endTrace(traceId, { totalTokens: 200, totalCostEstimate: 0.0042 });
      const summary = store.findById(traceId);
      assert.ok(summary);
      assert.ok(summary.endedAt);
      assert.equal(summary.totalTokens, 200);
      assert.equal(summary.totalCostEstimate, 0.0042);
    });
  });

  describe('saveSpans / getTrace', () => {
    let store: ObservabilityStore;
    let dir: string;
    let traceId: string;

    before(() => {
      ({ store, dir } = makeStore());
      traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('bulk-inserts spans and returns them via getTrace', () => {
      const llmSpan = makeSpan({ spanId: 'span-llm', traceId, type: 'llm-call' });
      const toolSpan = makeSpan({
        spanId: 'span-tool',
        traceId,
        type: 'tool-call',
        parentSpanId: 'span-llm',
        name: 'search',
      });
      store.saveSpans([llmSpan, toolSpan]);

      const trace = store.getTrace(traceId);
      assert.ok(trace);
      assert.equal(trace.spans.length, 2);
      assert.ok(trace.spans.find((s) => s.spanId === 'span-llm'));
      assert.ok(trace.spans.find((s) => s.spanId === 'span-tool'));
    });

    it('returns null for an unknown traceId from getTrace', () => {
      assert.equal(store.getTrace('no-such-id'), null);
    });
  });

  describe('find', () => {
    let store: ObservabilityStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      const t1 = store.startTrace({ threadId: 'thread-A', provider: 'openai', model: 'gpt-4o' });
      const t2 = store.startTrace({ threadId: 'thread-A', provider: 'openai', model: 'gpt-4o' });
      const t3 = store.startTrace({
        threadId: 'thread-B',
        provider: 'anthropic',
        model: 'claude-3-5',
      });
      store.endTrace(t1, { totalTokens: 100 });
      store.endTrace(t2, { totalTokens: 200 });
      store.endTrace(t3, { totalTokens: 50 });
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns all traces when no filters given', () => {
      const results = store.find();
      assert.equal(results.length, 3);
    });

    it('filters by threadId', () => {
      const results = store.find({ threadId: 'thread-A' });
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.threadId === 'thread-A'));
    });

    it('respects limit', () => {
      const results = store.find({ limit: 1 });
      assert.equal(results.length, 1);
    });

    it('filters by since', () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const results = store.find({ since: future });
      assert.equal(results.length, 0);
    });
  });

  describe('findById span counts', () => {
    let store: ObservabilityStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('counts llmCallCount and toolCallCount in TraceSummary', () => {
      const traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });
      store.saveSpans([
        makeSpan({ spanId: 'l1', traceId, type: 'llm-call' }),
        makeSpan({ spanId: 't1', traceId, type: 'tool-call', name: 'tool' }),
        makeSpan({ spanId: 't2', traceId, type: 'tool-call', name: 'tool' }),
      ]);
      const summary = store.findById(traceId);
      assert.ok(summary);
      assert.equal(summary.spanCount, 3);
      assert.equal(summary.llmCallCount, 1);
      assert.equal(summary.toolCallCount, 2);
    });
  });
});
