import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { logger } from '../config/logger.js';
import { bootThreadStore } from '../services/thread-store.js';
import { WorkspaceStore, bootWorkspaceStore, type Workspace } from '../services/workspace-store.js';
import { bootTaskScheduler } from '../services/task-scheduler.js';
import { setActiveSseWriter, clearActiveSseWriter } from './active-sse-writer.js';
import {
  streamWorkspaceChatToSse,
  resumeWorkspaceChatToSse,
  retryWorkspaceChatToSse,
  buildWorkspaceContext,
} from './workspace-chat-stream-handler.js';

// Monkey-patches one logger method to record calls while forwarding to the
// real implementation — mirrors the identical helper in chat-agent.test.ts.
function captureLogCalls(method: 'warn') {
  const spy = logger as unknown as Record<string, (msg: string, meta?: unknown) => void>;
  const original = spy[method].bind(logger);
  const calls: Array<{ message: string; meta: unknown }> = [];
  spy[method] = (message: string, meta?: unknown) => {
    calls.push({ message, meta });
    original(message, meta);
  };
  return {
    calls,
    restore: () => {
      spy[method] = original;
    },
  };
}

// A minimal fake Express Response — these functions call res.write() only
// via the sink they build internally.
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: (): ChatSSEEvent[] =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as ChatSSEEvent),
  };
}

// Issue #87's concurrency guard: an automated task run registers itself in
// the same active-sse-writer slot a live chat turn would, for the exact
// duration of its run — these three entry points must reject rather than
// race a second agent.streamEvents() invocation against the same LangGraph
// checkpoint. This suite only exercises that early-return guard (it fires
// before any agent/provider is touched); the full streaming happy path
// needs a real or stubbed LLM provider and isn't in scope here.
describe('agents/workspace-chat-stream-handler — concurrency guard', () => {
  let dir: string;
  let workspaceStore: WorkspaceStore;
  let workspace: Workspace;
  let threadId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-stream-guard-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    workspaceStore = new WorkspaceStore(db);
    bootWorkspaceStore(db);
    bootThreadStore(db);
    bootTaskScheduler();

    threadId = randomUUID();
    workspace = workspaceStore.createWorkspace({ name: 'W', location: '/tmp/w' });
    workspace = workspaceStore.patchWorkspace(workspace.id, { threadId })!;

    // Simulates an automated task run currently owning this thread.
    setActiveSseWriter(threadId, () => {});
  });

  afterEach(() => {
    clearActiveSseWriter(threadId);
    rmSync(dir, { recursive: true, force: true });
  });

  it('streamWorkspaceChatToSse rejects with stream_error when the thread is busy', async () => {
    const { res, events } = fakeRes();
    await streamWorkspaceChatToSse(res, workspace, threadId, 'hello', Date.now());

    const emitted = events();
    expect(emitted).to.have.length(1);
    expect(emitted[0]!.type).to.equal('stream_error');
  });

  it('resumeWorkspaceChatToSse rejects with stream_error when the thread is busy', async () => {
    const { res, events } = fakeRes();
    await resumeWorkspaceChatToSse(res, workspace, threadId, 'prompt-1', 'yes', Date.now());

    const emitted = events();
    expect(emitted).to.have.length(1);
    expect(emitted[0]!.type).to.equal('stream_error');
  });

  it('retryWorkspaceChatToSse rejects with stream_error when the thread is busy', async () => {
    const { res, events } = fakeRes();
    await retryWorkspaceChatToSse(res, workspace, threadId, Date.now());

    const emitted = events();
    expect(emitted).to.have.length(1);
    expect(emitted[0]!.type).to.equal('stream_error');
  });
});

describe('agents/workspace-chat-stream-handler — buildWorkspaceContext() summaries', () => {
  let dir: string;
  let workspaceStore: WorkspaceStore;
  let workspace: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-summaries-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    workspaceStore = new WorkspaceStore(db);
    bootWorkspaceStore(db);

    const location = mkdtempSync(join(dir, 'ws-'));
    workspace = workspaceStore.createWorkspace({ name: 'W', location });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('inlines the latest summary in full and manifests older ones', async () => {
    const summariesDir = join(workspace.location, '.hashbrown', 'summaries');
    await mkdir(summariesDir, { recursive: true });
    await writeFile(join(summariesDir, '2026-09-01T00-00-00-000Z.md'), '# First', 'utf8');
    await writeFile(join(summariesDir, '2026-09-02T00-00-00-000Z.md'), '# Second', 'utf8');
    await writeFile(join(summariesDir, '2026-09-03T00-00-00-000Z.md'), '# Latest', 'utf8');

    const ctx = await buildWorkspaceContext(workspace);

    expect(ctx.latestSummary).to.equal('# Latest');
    expect(ctx.olderSummaries).to.deep.equal([
      {
        path: join('.hashbrown', 'summaries', '2026-09-01T00-00-00-000Z.md'),
        timestamp: '2026-09-01T00-00-00-000Z',
      },
      {
        path: join('.hashbrown', 'summaries', '2026-09-02T00-00-00-000Z.md'),
        timestamp: '2026-09-02T00-00-00-000Z',
      },
    ]);
  });

  it('returns null/empty with no warning when .hashbrown/summaries does not exist', async () => {
    const log = captureLogCalls('warn');
    try {
      const ctx = await buildWorkspaceContext(workspace);
      expect(ctx.latestSummary).to.equal(null);
      expect(ctx.olderSummaries).to.deep.equal([]);
      expect(log.calls).to.have.length(0);
    } finally {
      log.restore();
    }
  });

  it('falls back gracefully and logs a warning when the latest summary file cannot be read', async () => {
    const summariesDir = join(workspace.location, '.hashbrown', 'summaries');
    await mkdir(summariesDir, { recursive: true });
    await writeFile(join(summariesDir, '2026-09-01T00-00-00-000Z.md'), '# First', 'utf8');
    // Lexically sorts last, so it's picked as "latest" — but it's a
    // directory, not a file, forcing readFile's EISDIR.
    mkdirSync(join(summariesDir, '2026-09-02T00-00-00-000Z.md'));

    const log = captureLogCalls('warn');
    try {
      const ctx = await buildWorkspaceContext(workspace);
      expect(ctx.latestSummary).to.equal(null);
      expect(ctx.olderSummaries).to.deep.equal([
        {
          path: join('.hashbrown', 'summaries', '2026-09-01T00-00-00-000Z.md'),
          timestamp: '2026-09-01T00-00-00-000Z',
        },
      ]);
      expect(log.calls.some((c) => c.message.includes('failed to read latest summary'))).to.equal(
        true,
      );
    } finally {
      log.restore();
    }
  });
});
