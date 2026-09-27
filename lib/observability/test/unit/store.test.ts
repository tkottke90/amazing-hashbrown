import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '../../src/store.js';
import type { SpanRecord } from '../../src/index.js';

function makeStore(): { store: ObservabilityStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'obs-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ObservabilityStore(db);
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

    it('round-trips a non-null systemPrompt via findById', () => {
      const traceId = store.startTrace({
        provider: 'openai',
        model: 'gpt-4o',
        systemPrompt: 'You have no built-in memory of this specific user.',
      });
      const summary = store.findById(traceId);
      assert.equal(summary?.systemPrompt, 'You have no built-in memory of this specific user.');
    });

    it('reads back null when systemPrompt is omitted', () => {
      const traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });
      const summary = store.findById(traceId);
      assert.equal(summary?.systemPrompt, null);
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

    it('round-trips a non-null error via findById and getTrace', () => {
      const traceId = store.startTrace({ provider: 'anthropic', model: 'claude-3-5' });
      store.endTrace(traceId, { totalTokens: 50, error: 'Context size has been exceeded' });
      const summary = store.findById(traceId);
      const trace = store.getTrace(traceId);
      assert.equal(summary?.error, 'Context size has been exceeded');
      assert.equal(trace?.error, 'Context size has been exceeded');
    });

    it('reads back null when error is omitted', () => {
      const traceId = store.startTrace({ provider: 'anthropic', model: 'claude-3-5' });
      store.endTrace(traceId, { totalTokens: 50 });
      const summary = store.findById(traceId);
      assert.equal(summary?.error, null);
    });
  });

  // recordModelInput snapshots what the model actually received on a turn —
  // the thread report relies on it to answer "was tool X bound on this
  // turn?", so both the first-call-wins rule and the null-vs-[] distinction
  // are part of the contract.
  describe('recordModelInput', () => {
    let store: ObservabilityStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('stores tools and the effective system prompt, readable via findById and getTrace [unit]', () => {
      const traceId = store.startTrace({
        provider: 'openai',
        model: 'gpt-4o',
        systemPrompt: 'build-time prompt',
      });
      store.recordModelInput(traceId, {
        tools: ['wiki_search', 'playwright__browser_click'],
        systemPrompt: 'effective prompt',
      });

      const summary = store.findById(traceId);
      const trace = store.getTrace(traceId);
      assert.deepEqual(summary?.tools, ['wiki_search', 'playwright__browser_click']);
      assert.deepEqual(trace?.tools, ['wiki_search', 'playwright__browser_click']);
      assert.equal(
        summary?.systemPrompt,
        'effective prompt',
        'effective prompt should replace build-time prompt',
      );
      assert.equal(trace?.systemPrompt, 'effective prompt');
    });

    it('keeps the first snapshot when a later model call in the same turn records again [unit]', () => {
      const traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });
      store.recordModelInput(traceId, { tools: ['first'], systemPrompt: 'first prompt' });
      store.recordModelInput(traceId, { tools: ['second'], systemPrompt: 'second prompt' });

      const trace = store.getTrace(traceId);
      assert.deepEqual(trace?.tools, ['first'], 'second recordModelInput should be a no-op');
      assert.equal(trace?.systemPrompt, 'first prompt');
    });

    it('keeps the startTrace prompt when no effective prompt is supplied [unit]', () => {
      const traceId = store.startTrace({
        provider: 'openai',
        model: 'gpt-4o',
        systemPrompt: 'build-time prompt',
      });
      store.recordModelInput(traceId, { tools: ['wiki_search'] });

      assert.equal(store.getTrace(traceId)?.systemPrompt, 'build-time prompt');
    });

    it('stores an empty tool list as [], distinct from not captured [unit]', () => {
      const traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });
      store.recordModelInput(traceId, { tools: [] });

      assert.deepEqual(store.getTrace(traceId)?.tools, []);
    });

    it('reads tools as null for a trace that never recorded model input [unit]', () => {
      const traceId = store.startTrace({ provider: 'openai', model: 'gpt-4o' });

      assert.equal(store.findById(traceId)?.tools, null);
      assert.equal(store.getTrace(traceId)?.tools, null);
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

    it('round-trips systemPrompt via getTrace', () => {
      const promptTraceId = store.startTrace({
        provider: 'openai',
        model: 'gpt-4o',
        systemPrompt: 'the whole title-generation prompt',
      });
      const trace = store.getTrace(promptTraceId);
      assert.equal(trace?.systemPrompt, 'the whole title-generation prompt');
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
