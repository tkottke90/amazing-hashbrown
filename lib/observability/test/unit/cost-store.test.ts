import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '../../src/store.js';
import { CostStore } from '../../src/cost-store.js';
import type { SpanRecord } from '../../src/index.js';

// The v_usage view joins observability_traces and observability_spans, so we need
// ObservabilityStore (migration 1) and CostStore (migration 2) on the same DB.
function makeStores(): { obs: ObservabilityStore; cost: CostStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cost-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const obs = new ObservabilityStore(db);
  const cost = new CostStore(db);
  return { obs, cost, dir };
}

function makeSpan(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    spanId: crypto.randomUUID(),
    traceId: 'trace-1',
    parentSpanId: null,
    type: 'llm-call',
    name: 'test-model',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    latencyMs: 100,
    inputTokens: 100,
    outputTokens: 50,
    outputPreview: null,
    inputPreview: null,
    error: null,
    ...overrides,
  };
}

describe('CostStore', () => {
  describe('migration', () => {
    let obs: ObservabilityStore;
    let cost: CostStore;
    let dir: string;

    before(() => ({ obs, cost, dir } = makeStores()));
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('creates provider_costs table', () => {
      // If the table didn't exist, getActiveCosts() would throw
      const rows = cost.getActiveCosts();
      assert.deepEqual(rows, []);
    });

    it('creates v_usage view', () => {
      // queryUsage on an empty DB should return [] without errors
      const today = new Date().toISOString().slice(0, 10);
      const rows = cost.queryUsage({ from: '2020-01-01', to: today });
      assert.deepEqual(rows, []);
    });
  });

  describe('insertCostRecord / getActiveCosts', () => {
    let obs: ObservabilityStore;
    let cost: CostStore;
    let dir: string;

    before(() => ({ obs, cost, dir } = makeStores()));
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('inserted record is returned with validUntil null', () => {
      cost.insertCostRecord({
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputPer1kTokens: 0.003,
        outputPer1kTokens: 0.015,
        configHash: 'hash-1',
        validFrom: '2026-01-01T00:00:00.000Z',
      });

      const active = cost.getActiveCosts();
      assert.equal(active.length, 1);
      assert.equal(active[0].providerName, 'anthropic');
      assert.equal(active[0].model, 'claude-sonnet-4-6');
      assert.equal(active[0].inputPer1kTokens, 0.003);
      assert.equal(active[0].outputPer1kTokens, 0.015);
      assert.equal(active[0].validUntil, null);
    });
  });

  describe('closeCostRecord', () => {
    let obs: ObservabilityStore;
    let cost: CostStore;
    let dir: string;

    before(() => ({ obs, cost, dir } = makeStores()));
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('sets validUntil and removes record from getActiveCosts()', () => {
      cost.insertCostRecord({
        providerName: 'openai',
        model: 'gpt-4.1-mini',
        inputPer1kTokens: 0.0004,
        outputPer1kTokens: 0.0012,
        configHash: 'hash-2',
        validFrom: '2026-01-01T00:00:00.000Z',
      });

      const before = cost.getActiveCosts();
      assert.equal(before.length, 1);

      cost.closeCostRecord(before[0].id, '2026-06-01T00:00:00.000Z');

      const after = cost.getActiveCosts();
      assert.equal(after.length, 0);
    });
  });

  describe('queryUsage', () => {
    let obs: ObservabilityStore;
    let cost: CostStore;
    let dir: string;

    before(() => {
      ({ obs, cost, dir } = makeStores());
    });
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('returns estimatedCost of 0 when no cost record matches', () => {
      const traceId = obs.startTrace({ provider: 'local', model: 'llama3.2' });
      obs.saveSpans([
        makeSpan({
          traceId,
          spanId: crypto.randomUUID(),
          startedAt: '2026-07-14T10:00:00.000Z',
          endedAt: '2026-07-14T10:00:01.000Z',
          inputTokens: 200,
          outputTokens: 100,
        }),
      ]);

      const rows = cost.queryUsage({ from: '2026-07-14', to: '2026-07-14' });
      const row = rows.find((r) => r.provider === 'local' && r.model === 'llama3.2');
      assert.ok(row, 'expected a usage row for local/llama3.2');
      assert.equal(row.estimatedCost, 0);
    });

    it('computes estimatedCost correctly when a cost record matches', () => {
      const traceId = obs.startTrace({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
      obs.saveSpans([
        makeSpan({
          traceId,
          spanId: crypto.randomUUID(),
          startedAt: '2026-07-14T11:00:00.000Z',
          endedAt: '2026-07-14T11:00:01.000Z',
          inputTokens: 1000,
          outputTokens: 500,
        }),
      ]);

      cost.insertCostRecord({
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputPer1kTokens: 0.003,
        outputPer1kTokens: 0.015,
        configHash: 'hash-a',
        validFrom: '2026-01-01T00:00:00.000Z',
      });

      const rows = cost.queryUsage({ from: '2026-07-14', to: '2026-07-14' });
      const row = rows.find(
        (r) => r.provider === 'anthropic' && r.model === 'claude-sonnet-4-6',
      );
      assert.ok(row, 'expected a usage row for anthropic/claude-sonnet-4-6');
      // 1000/1000 * 0.003 + 500/1000 * 0.015 = 0.003 + 0.0075 = 0.0105
      assert.ok(Math.abs(row.estimatedCost - 0.0105) < 0.0001, `expected ~0.0105, got ${row.estimatedCost}`);
    });

    it('excludes spans outside the date range', () => {
      const traceId = obs.startTrace({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
      obs.saveSpans([
        makeSpan({
          traceId,
          spanId: crypto.randomUUID(),
          startedAt: '2025-01-01T00:00:00.000Z',
          endedAt: '2025-01-01T00:00:01.000Z',
          inputTokens: 9999,
          outputTokens: 9999,
        }),
      ]);

      // Query only 2026-07-14 — the 2025 span must not appear
      const rows = cost.queryUsage({ from: '2026-07-14', to: '2026-07-14' });
      const totalTokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
      // The 2025 span's tokens (9999 + 9999) should not be in this total
      assert.ok(totalTokens < 9999, `unexpected tokens from out-of-range span: ${totalTokens}`);
    });
  });

  describe('historical pricing', () => {
    let obs: ObservabilityStore;
    let cost: CostStore;
    let dir: string;

    before(() => {
      ({ obs, cost, dir } = makeStores());

      // Insert a cost record valid before the price change
      cost.insertCostRecord({
        providerName: 'openai',
        model: 'gpt-4.1-mini',
        inputPer1kTokens: 0.001,
        outputPer1kTokens: 0.002,
        configHash: 'old-hash',
        validFrom: '2026-01-01T00:00:00.000Z',
      });

      // Simulate a price change on 2026-07-01: close the old record, open a new one
      const active = cost.getActiveCosts();
      const oldRecord = active.find((r) => r.model === 'gpt-4.1-mini');
      assert.ok(oldRecord);
      cost.closeCostRecord(oldRecord.id, '2026-07-01T00:00:00.000Z');

      cost.insertCostRecord({
        providerName: 'openai',
        model: 'gpt-4.1-mini',
        inputPer1kTokens: 0.002,
        outputPer1kTokens: 0.004,
        configHash: 'new-hash',
        validFrom: '2026-07-01T00:00:00.000Z',
      });

      // Span BEFORE the price change (old rates apply)
      const traceOld = obs.startTrace({ provider: 'openai', model: 'gpt-4.1-mini' });
      obs.saveSpans([
        makeSpan({
          traceId: traceOld,
          spanId: crypto.randomUUID(),
          startedAt: '2026-06-15T10:00:00.000Z',
          endedAt: '2026-06-15T10:00:01.000Z',
          inputTokens: 1000,
          outputTokens: 1000,
        }),
      ]);

      // Span AFTER the price change (new rates apply)
      const traceNew = obs.startTrace({ provider: 'openai', model: 'gpt-4.1-mini' });
      obs.saveSpans([
        makeSpan({
          traceId: traceNew,
          spanId: crypto.randomUUID(),
          startedAt: '2026-07-10T10:00:00.000Z',
          endedAt: '2026-07-10T10:00:01.000Z',
          inputTokens: 1000,
          outputTokens: 1000,
        }),
      ]);
    });
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('prices spans at the rate active when they ran', () => {
      const oldRows = cost.queryUsage({
        from: '2026-06-15',
        to: '2026-06-15',
        provider: 'openai',
        model: 'gpt-4.1-mini',
      });
      assert.equal(oldRows.length, 1);
      // 1000/1000 * 0.001 + 1000/1000 * 0.002 = 0.003
      assert.ok(
        Math.abs(oldRows[0].estimatedCost - 0.003) < 0.0001,
        `old rate: expected ~0.003, got ${oldRows[0].estimatedCost}`,
      );

      const newRows = cost.queryUsage({
        from: '2026-07-10',
        to: '2026-07-10',
        provider: 'openai',
        model: 'gpt-4.1-mini',
      });
      assert.equal(newRows.length, 1);
      // 1000/1000 * 0.002 + 1000/1000 * 0.004 = 0.006
      assert.ok(
        Math.abs(newRows[0].estimatedCost - 0.006) < 0.0001,
        `new rate: expected ~0.006, got ${newRows[0].estimatedCost}`,
      );
    });
  });
});
