import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import { ShellAuditStore } from './shell-audit.js';

describe('services/shell-audit', () => {
  let dir: string;
  let store: ShellAuditStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shell-audit-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    // v_file_tool_adoption reads observability_spans, so that table needs to
    // exist too — same cross-store DB-sharing pattern the friction-store
    // tests use.
    new ObservabilityStore(db);
    store = new ShellAuditStore(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a read command into is_file_read on write', () => {
    store.write({
      timestamp: '2026-07-14T10:00:00.000Z',
      command: 'cat notes.txt',
      outcome: 'allowed',
      source: 'policy',
      trustAll: false,
    });

    const rows = store.queryFileToolAdoption({ from: '2026-07-14', to: '2026-07-14' });
    const shellRow = rows.find((r) => r.source === 'shell_exec');
    expect(shellRow).to.deep.include({ readCount: 1, writeCount: 0 });
  });

  it('classifies a write command into is_file_write on write', () => {
    store.write({
      timestamp: '2026-07-14T10:00:00.000Z',
      command: "sed -i 's/x/y/' notes.txt",
      outcome: 'allowed',
      source: 'policy',
      trustAll: false,
    });

    const rows = store.queryFileToolAdoption({ from: '2026-07-14', to: '2026-07-14' });
    const shellRow = rows.find((r) => r.source === 'shell_exec');
    expect(shellRow).to.deep.include({ readCount: 0, writeCount: 1 });
  });

  it('counts a chained read+write command in both buckets', () => {
    store.write({
      timestamp: '2026-07-14T10:00:00.000Z',
      command: "cat notes.txt && sed -i 's/x/y/' notes.txt",
      outcome: 'allowed',
      source: 'policy',
      trustAll: false,
    });

    const rows = store.queryFileToolAdoption({ from: '2026-07-14', to: '2026-07-14' });
    const shellRow = rows.find((r) => r.source === 'shell_exec');
    expect(shellRow).to.deep.include({ readCount: 1, writeCount: 1 });
  });
});
