import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore, ToolFrictionStore } from '@tkottke90/observability';
import type { SpanRecord } from '@tkottke90/observability';
import { ShellAuditStore } from '../../services/shell-audit.js';
import { getToolFrictionHandler, getFileToolAdoptionHandler } from './metrics.handlers.js';

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

describe('routes/v1/metrics.handlers', () => {
  let dir: string;
  let obs: ObservabilityStore;
  let friction: ToolFrictionStore;
  let shellAudit: ShellAuditStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metrics-handlers-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    obs = new ObservabilityStore(db);
    friction = new ToolFrictionStore(db);
    shellAudit = new ShellAuditStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('getToolFrictionHandler', () => {
    it('returns aggregated rows for the given date range', () => {
      const traceId = obs.startTrace({ provider: 'local', model: 'llama3.2' });
      obs.saveSpans([
        makeSpan({ traceId, startedAt: '2026-07-14T10:00:00.000Z' }),
        makeSpan({
          spanId: crypto.randomUUID(),
          traceId,
          startedAt: '2026-07-14T11:00:00.000Z',
          error: 'boom',
        }),
      ]);

      const result = getToolFrictionHandler(friction, { from: '2026-07-14', to: '2026-07-14' });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.rows).to.have.length(1);
      expect(result.data.rows[0]).to.include({
        toolName: 'find_file',
        callCount: 2,
        errorCount: 1,
      });
    });

    it('defaults to the last 30 days when no range is given', () => {
      const result = getToolFrictionHandler(friction, {});
      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.from).to.be.a('string');
      expect(result.data.to).to.be.a('string');
    });
  });

  describe('getFileToolAdoptionHandler', () => {
    it('returns both file-ops and shell_exec rows for the same day', () => {
      const traceId = obs.startTrace({ provider: 'local', model: 'llama3.2' });
      obs.saveSpans([
        makeSpan({ traceId, name: 'edit_file', startedAt: '2026-07-14T10:00:00.000Z' }),
      ]);
      shellAudit.write({
        timestamp: '2026-07-14T09:00:00.000Z',
        command: 'cat notes.txt',
        outcome: 'allowed',
        source: 'policy',
        trustAll: false,
      });

      const result = getFileToolAdoptionHandler(shellAudit, {
        from: '2026-07-14',
        to: '2026-07-14',
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      const fileOpsRow = result.data.rows.find((r) => r.source === 'file-ops');
      const shellRow = result.data.rows.find((r) => r.source === 'shell_exec');
      expect(fileOpsRow).to.include({ writeCount: 1 });
      expect(shellRow).to.include({ readCount: 1 });
    });
  });
});
