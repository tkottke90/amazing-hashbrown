import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { logger } from '../config/logger.js';
import { ThreadStore } from '../services/thread-store.js';
import { WorkspaceStore, type Workspace } from '../services/workspace-store.js';
import { bootObservability } from '../services/observability.js';
import { maybeSummarizeWorkspace } from './workspace-summarizer.js';
import { isSummaryBoundary } from './summary-boundary.js';

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

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

// A minimal fake SseWriter — writeSseEvent() now just calls the sink
// directly with the event object, so this only needs to record it. events()
// keeps the loose Record<string, unknown> cast the old fakeRes() used, so
// assertions below can read whichever event-specific field they need
// without narrowing the ChatSSEEvent union first.
function fakeSink() {
  const chunks: ChatSSEEvent[] = [];
  return {
    sink: (event: ChatSSEEvent) => chunks.push(event),
    events: () => chunks as unknown as Record<string, unknown>[],
  };
}

function seedConversationalMessages(
  threadStore: ThreadStore,
  threadId: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    threadStore.insertMessage(threadId, {
      id: `u${i}`,
      kind: 'user',
      payload: { content: `message ${i}` },
    });
  }
}

describe('agents/workspace-summarizer', () => {
  let dir: string;
  let threadStore: ThreadStore;
  let workspaceStore: WorkspaceStore;
  let workspace: Workspace;
  // A real createAgent()+SqliteSaver pair (thread-fork.test.ts's established
  // pattern for exercising real LangGraph checkpoint state in tests). The
  // model is never invoked in these tests — only agent.graph.updateState()/
  // getState() are exercised — so a bare FakeListChatModel is fine to share
  // across every test/thread_id in this suite.
  let checkpointDb: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agent: any;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-summarizer-test-'));
    const threadDb = openDatabase(join(dir, 'threads.db'));
    threadStore = new ThreadStore(threadDb);
    const workspaceDb = openDatabase(join(dir, 'workspaces.db'));
    workspaceStore = new WorkspaceStore(workspaceDb);
    const obsDb = openDatabase(join(dir, 'observability.db'));
    bootObservability(obsDb);

    checkpointDb = new Database(join(dir, 'checkpoints.db'));
    const checkpointer = new SqliteSaver(checkpointDb);
    agent = createAgent({
      model: new FakeListChatModel({ responses: ['unused'] }),
      tools: [],
      checkpointer,
    });
  });

  after(() => {
    threadStore.close();
    checkpointDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const location = mkdtempSync(join(dir, 'ws-'));
    const threadId = randomUUID();
    threadStore.upsertThreadOnFirstMessage(threadId, 'placeholder', 'workspace-chat');
    workspace = workspaceStore.createWorkspace({ name: 'W', location });
    workspace = workspaceStore.patchWorkspace(workspace.id, { threadId })!;
  });

  it('does nothing when there are fewer messages than the threshold and force is not set', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 3);
    const model = new FakeListChatModel({ responses: ['# Summary'] });

    await maybeSummarizeWorkspace(
      undefined,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      model,
      undefined,
      undefined,
    );

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.equal(null);
    expect(reloaded.lastSummarizedMessageId).to.equal(null);
  });

  it('summarizes automatically once the message threshold is crossed', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 40);
    const model = new FakeListChatModel({ responses: ['# Summary\n\nKey decision: use SQLite.'] });
    const { sink, events } = fakeSink();

    await maybeSummarizeWorkspace(
      sink,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      model,
      'local',
      'fake-model',
    );

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.not.equal(null);
    expect(reloaded.lastSummarizedMessageId).to.not.equal(null);

    // The summary file was actually written to disk under .hashbrown/summaries/
    const summaryDir = join(workspace.location, '.hashbrown', 'summaries');
    expect(existsSync(summaryDir)).to.equal(true);
    expect(readdirSync(summaryDir).length).to.equal(1);

    // A kind:'summary' message was inserted, and it IS the new cursor —
    // fetching messages after the cursor should exclude it.
    const summaryMessage = threadStore.getMessage(
      workspace.threadId!,
      reloaded.lastSummarizedMessageId!,
    );
    expect(summaryMessage).to.not.equal(null);
    expect(summaryMessage!.kind).to.equal('summary');

    const afterCursor = threadStore.getThreadMessages(workspace.threadId!, {
      afterMessageId: reloaded.lastSummarizedMessageId!,
    });
    expect(afterCursor.length).to.equal(0);

    expect(events().some((e) => e.type === 'summarizing_start')).to.equal(true);
    expect(events().some((e) => e.type === 'summarizing_end' && e.error === undefined)).to.equal(
      true,
    );
  });

  it('records a boundary marker message in the checkpoint after a successful summarize', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 40);
    const model = new FakeListChatModel({ responses: ['# Summary'] });

    await maybeSummarizeWorkspace(
      undefined,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      model,
      undefined,
      undefined,
    );

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    const state = await agent.graph.getState({
      configurable: { thread_id: workspace.threadId },
    });
    const lastMessage = state.values.messages[state.values.messages.length - 1];
    expect(isSummaryBoundary(lastMessage)).to.equal(true);
    const tag = lastMessage.additional_kwargs['hashbrown'] as { summaryPath?: string };
    expect(tag.summaryPath).to.equal(reloaded.summaryPath);
  });

  it('still succeeds (file + thread-store row written) even if the checkpoint boundary write fails', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 40);
    const model = new FakeListChatModel({ responses: ['# Summary'] });
    const failingAgent = {
      graph: {
        updateState: async () => {
          throw new Error('checkpoint write boom');
        },
      },
    };

    const log = captureLogCalls('warn');
    try {
      await maybeSummarizeWorkspace(
        undefined,
        workspaceStore,
        threadStore,
        workspace,
        failingAgent,
        model,
        undefined,
        undefined,
      );

      const reloaded = workspaceStore.getWorkspace(workspace.id)!;
      expect(reloaded.summaryPath).to.not.equal(null);
      expect(reloaded.lastSummarizedMessageId).to.not.equal(null);
      expect(log.calls.some((c) => c.message.includes('checkpoint boundary marker'))).to.equal(
        true,
      );
    } finally {
      log.restore();
    }
  });

  it('force:true summarizes even below the threshold', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 2);
    const model = new FakeListChatModel({ responses: ['# Summary'] });

    await maybeSummarizeWorkspace(
      undefined,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      model,
      undefined,
      undefined,
      { force: true },
    );

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.not.equal(null);
  });

  it('force:true with zero new messages since the last summary is a no-op', async () => {
    // No conversational messages seeded at all.
    const model = new FakeListChatModel({ responses: ['# Summary'] });

    await maybeSummarizeWorkspace(
      undefined,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      model,
      undefined,
      undefined,
      { force: true },
    );

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.equal(null);
  });

  it('leaves the cursor/summaryPath untouched and emits an error event when the model throws', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 40);
    const model = new ThrowingChatModel({});
    const { sink, events } = fakeSink();

    await maybeSummarizeWorkspace(
      sink,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      model,
      undefined,
      undefined,
    );

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.equal(null);
    expect(reloaded.lastSummarizedMessageId).to.equal(null);

    const endEvent = events().find((e) => e.type === 'summarizing_end');
    expect(endEvent).to.not.equal(undefined);
    expect(endEvent!.error).to.be.a('string');
  });

  it('never throws — the caller must be safe to call after finalizeTurn has already completed the turn', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 40);
    const model = new ThrowingChatModel({});

    let threw = false;
    try {
      await maybeSummarizeWorkspace(
        undefined,
        workspaceStore,
        threadStore,
        workspace,
        agent,
        model,
        undefined,
        undefined,
      );
    } catch {
      threw = true;
    }
    expect(threw).to.equal(false);
  });
});
