import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ThreadStore } from '../services/thread-store.js';
import { WorkspaceStore, type Workspace } from '../services/workspace-store.js';
import { bootObservability } from '../services/observability.js';
import { maybeSummarizeWorkspace } from './workspace-summarizer.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

// A minimal fake Response — same shape as stream-handler.test.ts's fakeRes(),
// since writeSseEvent() only ever calls res.write().
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: () =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as Record<string, unknown>),
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

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-summarizer-test-'));
    const threadDb = openDatabase(join(dir, 'threads.db'));
    threadStore = new ThreadStore(threadDb);
    const workspaceDb = openDatabase(join(dir, 'workspaces.db'));
    workspaceStore = new WorkspaceStore(workspaceDb);
    const obsDb = openDatabase(join(dir, 'observability.db'));
    bootObservability(obsDb);
  });

  after(() => {
    threadStore.close();
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

    await maybeSummarizeWorkspace(undefined, workspaceStore, threadStore, workspace, model, undefined, undefined);

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.equal(null);
    expect(reloaded.lastSummarizedMessageId).to.equal(null);
  });

  it('summarizes automatically once the message threshold is crossed', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 40);
    const model = new FakeListChatModel({ responses: ['# Summary\n\nKey decision: use SQLite.'] });
    const { res, events } = fakeRes();

    await maybeSummarizeWorkspace(res, workspaceStore, threadStore, workspace, model, 'local', 'fake-model');

    const reloaded = workspaceStore.getWorkspace(workspace.id)!;
    expect(reloaded.summaryPath).to.not.equal(null);
    expect(reloaded.lastSummarizedMessageId).to.not.equal(null);

    // The summary file was actually written to disk under .hashbrown/summaries/
    const summaryDir = join(workspace.location, '.hashbrown', 'summaries');
    expect(existsSync(summaryDir)).to.equal(true);
    expect(readdirSync(summaryDir).length).to.equal(1);

    // A kind:'summary' message was inserted, and it IS the new cursor —
    // fetching messages after the cursor should exclude it.
    const summaryMessage = threadStore.getMessage(workspace.threadId!, reloaded.lastSummarizedMessageId!);
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

  it('force:true summarizes even below the threshold', async () => {
    seedConversationalMessages(threadStore, workspace.threadId!, 2);
    const model = new FakeListChatModel({ responses: ['# Summary'] });

    await maybeSummarizeWorkspace(
      undefined,
      workspaceStore,
      threadStore,
      workspace,
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
    const { res, events } = fakeRes();

    await maybeSummarizeWorkspace(res, workspaceStore, threadStore, workspace, model, undefined, undefined);

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
