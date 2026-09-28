import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '../../src/store.js';
import { ToolFrictionStore } from '../../src/friction-store.js';
import type { SpanRecord } from '../../src/index.js';

// v_tool_friction reads observability_spans directly (no join with
// observability_traces, unlike v_usage) but the spans table is still created
// by ObservabilityStore's own migration, so both stores are needed on the
// same DB to exercise this against real data.
function makeStores(): { obs: ObservabilityStore; friction: ToolFrictionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'friction-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const obs = new ObservabilityStore(db);
  const friction = new ToolFrictionStore(db);
  return { obs, friction, dir };
}

function makeSpan(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    spanId: crypto.randomUUID(),
    traceId: 'trace-1',
    parentSpanId: null,
    type: 'tool-call',
    name: 'find_file',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    latencyMs: 10,
    inputTokens: null,
    outputTokens: null,
    outputPreview: null,
    inputPreview: null,
    error: null,
    ...overrides,
  };
}

describe('ToolFrictionStore', () => {
  describe('migration', () => {
    let obs: ObservabilityStore;
    let friction: ToolFrictionStore;
    let dir: string;

    before(() => ({ obs, friction, dir } = makeStores()));
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('creates v_tool_friction view', () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = friction.queryFriction({ from: '2020-01-01', to: today });
      assert.deepEqual(rows, []);
    });
  });

  describe('queryFriction', () => {
    let obs: ObservabilityStore;
    let friction: ToolFrictionStore;
    let dir: string;

    before(() => {
      ({ obs, friction, dir } = makeStores());
      const traceId = obs.startTrace({ provider: 'local', model: 'llama3.2' });
      obs.saveSpans([
        makeSpan({
          traceId,
          name: 'find_file',
          startedAt: '2026-07-14T10:00:00.000Z',
          error: null,
        }),
        makeSpan({
          spanId: crypto.randomUUID(),
          traceId,
          name: 'find_file',
          startedAt: '2026-07-14T11:00:00.000Z',
          error: 'boom',
        }),
        makeSpan({
          spanId: crypto.randomUUID(),
          traceId,
          name: 'edit_file',
          startedAt: '2026-07-14T12:00:00.000Z',
          error: null,
        }),
        makeSpan({
          spanId: crypto.randomUUID(),
          traceId,
          name: 'find_file',
          startedAt: '2025-01-01T00:00:00.000Z',
          error: null,
        }),
      ]);
    });
    after(() => {
      obs.close();
      rmSync(dir, { recursive: true });
    });

    it('aggregates call_count and error_count per tool per day', () => {
      const rows = friction.queryFriction({ from: '2026-07-14', to: '2026-07-14' });
      const findFile = rows.find((r) => r.toolName === 'find_file');
      const editFile = rows.find((r) => r.toolName === 'edit_file');

      assert.ok(findFile, 'expected a row for find_file');
      assert.equal(findFile.callCount, 2);
      assert.equal(findFile.errorCount, 1);
      assert.ok(editFile, 'expected a row for edit_file');
      assert.equal(editFile.callCount, 1);
      assert.equal(editFile.errorCount, 0);
    });

    it('excludes spans outside the date range', () => {
      const rows = friction.queryFriction({ from: '2026-07-14', to: '2026-07-14' });
      const totalCalls = rows.reduce((sum, r) => sum + r.callCount, 0);
      // The 2025 find_file span should not be counted here
      assert.equal(totalCalls, 3);
    });

    it('filters by toolName when given', () => {
      const rows = friction.queryFriction({
        from: '2026-07-14',
        to: '2026-07-14',
        toolName: 'edit_file',
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.toolName, 'edit_file');
    });
  });
});
