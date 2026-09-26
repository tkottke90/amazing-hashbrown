import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { logger } from '../config/logger.js';
import { configManager } from '../config/env.js';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { WorkspaceStore, bootWorkspaceStore, type Workspace } from '../services/workspace-store.js';
import { bootTaskScheduler } from '../services/task-scheduler.js';
import {
  setActiveSseWriter,
  clearActiveSseWriter,
  getActiveSseWriter,
  getActiveTurnAbort,
} from './active-sse-writer.js';
import { ClassifiedTurnError } from './stream-handler.js';
import { recordAssistantStart } from './thread-message-writer.js';
import {
  streamWorkspaceChatToSse,
  resumeWorkspaceChatToSse,
  retryWorkspaceChatToSse,
  buildWorkspaceContext,
  type WorkspaceChatStreamDeps,
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

// Regression coverage for issue #196: an interactive workspace-chat turn
// that's explicitly Stopped (via the new /stop route calling
// stopActiveTurn(), which aborts the controller registered here) must
// persist a 'cancelled' row and actually release the active-sse-writer
// mutex — the reported symptom was this exact thread staying stuck
// rejecting new turns with "This workspace has a task running".
describe('agents/workspace-chat-stream-handler — abort handling', () => {
  const TEST_PROVIDER = 'workspace-chat-abort-test-provider';
  const NAMED_OPENAI_PROVIDER = 'glm-classification-test-provider';
  let dir: string;
  let workspaceStore: WorkspaceStore;
  let workspace: Workspace;
  let threadId: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type RawEvent = Record<string, any>;

  // Mirrors task-execution.test.ts's fakeAbortingAgent: looks up the REAL
  // controller streamWorkspaceChatToSse/etc. already registered via
  // setActiveSseWriter(threadId, sink, controller), aborts it itself, then
  // throws — no ordering race with the code under test's own registration.
  function fakeAbortingAgent(tid: string, eventsBeforeAbort: RawEvent[] = []) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamEvents: (): AsyncIterable<any> => {
        async function* gen() {
          for (const e of eventsBeforeAbort) yield e;
          const controller = getActiveTurnAbort(tid);
          if (!controller) throw new Error('test setup error: no controller registered');
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return gen();
      },
      graph: {
        getState: async () => ({
          tasks: [],
          config: { configurable: { checkpoint_id: 'cp-test' } },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function fakeThrowingAgent(eventsBeforeThrow: RawEvent[] = []) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamEvents: (): AsyncIterable<any> => {
        async function* gen() {
          for (const e of eventsBeforeThrow) yield e;
          throw new Error('simulated stream failure');
        }
        return gen();
      },
      graph: {
        getState: async () => ({
          tasks: [],
          config: { configurable: { checkpoint_id: 'cp-test' } },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  // Throws the error shape the OpenAI SDK's APIError carries for an HTTP 403
  // (a numeric `status`, message "403 <body>") on the very first model call.
  function fakeForbiddenAgent() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamEvents: (): AsyncIterable<any> => {
        async function* gen() {
          yield* [];
          throw Object.assign(new Error('403 Forbidden'), { status: 403 });
        }
        return gen();
      },
      graph: {
        getState: async () => ({
          tasks: [],
          config: { configurable: { checkpoint_id: 'cp-test' } },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function depsFor(agent: unknown): WorkspaceChatStreamDeps {
    return {
      getWorkspaceChatAgent: async () => ({ agent, systemPrompt: 'test system prompt' }) as never,
    };
  }

  async function expectClassifiedTurnError(promise: Promise<void>): Promise<ClassifiedTurnError> {
    try {
      await promise;
    } catch (err) {
      expect(err).to.be.instanceOf(ClassifiedTurnError);
      return err as ClassifiedTurnError;
    }
    throw new Error('expected the handler to throw');
  }

  before(() => {
    configManager.set('providers', [
      {
        name: TEST_PROVIDER,
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'test-model',
      },
      // A user-named OpenAI-compatible provider — the name deliberately isn't
      // 'openai', so error classification must key off `type`, not `name`.
      {
        name: NAMED_OPENAI_PROVIDER,
        type: 'openai',
        apiKey: 'test-key',
        defaultModel: 'test-model',
      },
    ]);
    configManager.set('defaultProvider', TEST_PROVIDER);
  });

  after(() => {
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-stream-abort-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    workspaceStore = new WorkspaceStore(db);
    bootWorkspaceStore(db);
    bootThreadStore(db);
    bootTaskScheduler();

    threadId = randomUUID();
    workspace = workspaceStore.createWorkspace({ name: 'W', location: '/tmp/w' });
    workspace = workspaceStore.patchWorkspace(workspace.id, { threadId })!;
  });

  afterEach(() => {
    clearActiveSseWriter(threadId);
    rmSync(dir, { recursive: true, force: true });
  });

  it('streamWorkspaceChatToSse persists a cancelled turn and releases the mutex when aborted mid-stream', async () => {
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      streamWorkspaceChatToSse(
        res,
        workspace,
        threadId,
        'hello',
        Date.now(),
        undefined,
        undefined,
        undefined,
        depsFor(fakeAbortingAgent(threadId)),
      ),
    );
    expect(err.category).to.equal('cancelled');

    // The literal regression test for #196.
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
    expect(getActiveTurnAbort(threadId)).to.equal(undefined);

    const persisted = getThreadStore()
      .getThreadMessages(threadId)
      .find((m) => m.kind === 'assistant' && m.status === 'error');
    expect(persisted, 'expected a persisted error-status assistant row').to.not.equal(undefined);
    expect((persisted!.payload as { errorCategory?: string }).errorCategory).to.equal('cancelled');
  });

  it('streamWorkspaceChatToSse still fails normally (not cancelled) when the stream throws without being aborted', async () => {
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      streamWorkspaceChatToSse(
        res,
        workspace,
        threadId,
        'hello',
        Date.now(),
        undefined,
        undefined,
        undefined,
        depsFor(fakeThrowingAgent()),
      ),
    );
    expect(err.category).to.not.equal('cancelled');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });

  it('streamWorkspaceChatToSse classifies a 403 from a custom-named OpenAI-type provider as auth [orchestration]', async () => {
    // Regression: the handler used to pass the provider's configured *name*
    // to classifyChatError, which only recognizes provider *types* — so any
    // provider not literally named 'openai' fell through to 'unknown', and
    // the UI showed a bare "403 Forbidden" instead of the auth guidance.
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      streamWorkspaceChatToSse(
        res,
        workspace,
        threadId,
        'hello',
        Date.now(),
        NAMED_OPENAI_PROVIDER,
        undefined,
        undefined,
        depsFor(fakeForbiddenAgent()),
      ),
    );
    expect(err.category, 'a 403 from an openai-type provider must be classified as auth').to.equal(
      'auth',
    );

    const persisted = getThreadStore()
      .getThreadMessages(threadId)
      .find((m) => m.kind === 'assistant' && m.status === 'error');
    expect((persisted!.payload as { errorCategory?: string }).errorCategory).to.equal('auth');
  });

  it('resumeWorkspaceChatToSse persists a cancelled turn and releases the mutex when aborted mid-stream', async () => {
    getThreadStore().upsertThreadOnFirstMessage(threadId, 'hello', 'workspace-chat');
    recordAssistantStart(getThreadStore(), threadId, randomUUID(), new Date().toISOString());
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      resumeWorkspaceChatToSse(
        res,
        workspace,
        threadId,
        'no-such-prompt',
        'yes',
        Date.now(),
        undefined,
        undefined,
        undefined,
        depsFor(fakeAbortingAgent(threadId)),
      ),
    );
    expect(err.category).to.equal('cancelled');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });

  it('retryWorkspaceChatToSse persists a cancelled turn and releases the mutex when aborted mid-stream', async () => {
    getThreadStore().upsertThreadOnFirstMessage(threadId, 'hello', 'workspace-chat');
    const failedId = randomUUID();
    recordAssistantStart(getThreadStore(), threadId, failedId, new Date().toISOString());
    getThreadStore().updateMessage(threadId, failedId, {
      status: 'error',
      payload: { content: '' },
    });
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      retryWorkspaceChatToSse(
        res,
        workspace,
        threadId,
        Date.now(),
        undefined,
        undefined,
        undefined,
        depsFor(fakeAbortingAgent(threadId)),
      ),
    );
    expect(err.category).to.equal('cancelled');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
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
