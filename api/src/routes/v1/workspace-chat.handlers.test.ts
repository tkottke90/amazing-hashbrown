import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import {
  bootWorkspaceStore,
  getWorkspaceStore,
  type Workspace,
} from '../../services/workspace-store.js';
import {
  bootWakeupStore,
  getWakeupStore,
  type WakeupCancelSource,
} from '../../services/wakeup-store.js';
import { replaceThreadHandler, type WakeupCanceler } from './workspace-chat.handlers.js';

function fakeRegistry(impl?: (id: string, by: WakeupCancelSource) => void): {
  canceler: WakeupCanceler;
  calls: Array<{ id: string; by: WakeupCancelSource }>;
} {
  const calls: Array<{ id: string; by: WakeupCancelSource }> = [];
  return {
    calls,
    canceler: {
      cancel(id, by) {
        calls.push({ id, by });
        impl?.(id, by);
        return getWakeupStore().cancel(id, by);
      },
    },
  };
}

describe('routes/v1/workspace-chat.handlers: replaceThreadHandler', () => {
  let dir: string;
  let workspace: Workspace;
  let oldThreadId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-chat-handlers-test-'));
    const threadDb = openDatabase(join(dir, 'threads.db'));
    bootThreadStore(threadDb);
    bootWakeupStore(threadDb);
    const workspaceDb = openDatabase(join(dir, 'workspaces.db'));
    bootWorkspaceStore(workspaceDb);

    oldThreadId = 'old-thread-1';
    getThreadStore().upsertThreadOnFirstMessage(oldThreadId, 'Old Thread', 'workspace-chat');
    const created = getWorkspaceStore().createWorkspace({ name: 'W', location: '/tmp/ws' });
    workspace = getWorkspaceStore().patchWorkspace(created.id, { threadId: oldThreadId })!;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stubSummarize(summaryPath = 'summaries/final.md') {
    const calls: Array<{ supersededBy: string }> = [];
    return {
      calls,
      summarize: async (ws: Workspace, supersededBy: string) => {
        calls.push({ supersededBy });
        getWorkspaceStore().patchWorkspace(ws.id, { summaryPath });
      },
    };
  }

  it('400s when the workspace has no active thread to replace', async () => {
    const bare = getWorkspaceStore().createWorkspace({ name: 'Bare', location: '/tmp/bare' });
    const { canceler } = fakeRegistry();
    const { summarize } = stubSummarize();

    const result = await replaceThreadHandler(
      {
        workspaceStore: getWorkspaceStore(),
        threadStore: getThreadStore(),
        wakeupStore: getWakeupStore(),
        wakeupRegistry: canceler,
        summarize,
      },
      bare,
    );

    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(400);
  });

  it('archives + retitles the old thread, repoints the workspace, and resets the cursor', async () => {
    const { canceler } = fakeRegistry();
    const { summarize, calls: summarizeCalls } = stubSummarize('summaries/final.md');

    const result = await replaceThreadHandler(
      {
        workspaceStore: getWorkspaceStore(),
        threadStore: getThreadStore(),
        wakeupStore: getWakeupStore(),
        wakeupRegistry: canceler,
        summarize,
      },
      workspace,
    );

    expect(result.ok).to.equal(true);
    if (!result.ok) throw new Error('expected success');
    const newThreadId = result.data.threadId;
    expect(result.data.archivedThreadId).to.equal(oldThreadId);
    expect(summarizeCalls).to.have.length(1);
    expect(summarizeCalls[0]!.supersededBy).to.equal(newThreadId);

    const oldMeta = getThreadStore().getThreadMeta(oldThreadId)!;
    expect(oldMeta.archivedAt).to.not.equal(null);
    expect(oldMeta.title).to.equal('Old Thread (replaced)');

    const refreshed = getWorkspaceStore().getWorkspace(workspace.id)!;
    expect(refreshed.threadId).to.equal(newThreadId);
    expect(refreshed.lastSummarizedMessageId).to.equal(null);
    // summaryPath keeps pointing at the final summary the stub just wrote —
    // the migration step must not clobber it.
    expect(refreshed.summaryPath).to.equal('summaries/final.md');
  });

  it('cancels a pending wake-up on the old thread with settledBy thread_replaced', async () => {
    const wakeup = getWakeupStore().schedule({
      threadId: oldThreadId,
      note: 'check back',
      fireAt: new Date(Date.now() + 60_000),
      chainDepth: 0,
    });
    const { canceler, calls } = fakeRegistry();
    const { summarize } = stubSummarize();

    const result = await replaceThreadHandler(
      {
        workspaceStore: getWorkspaceStore(),
        threadStore: getThreadStore(),
        wakeupStore: getWakeupStore(),
        wakeupRegistry: canceler,
        summarize,
      },
      workspace,
    );

    expect(result.ok).to.equal(true);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.deep.equal({ id: wakeup.id, by: 'thread_replaced' });
    expect(getWakeupStore().get(wakeup.id)!.status).to.equal('cancelled');
  });

  it('is a no-op, not an error, when there is no pending wake-up', async () => {
    const { canceler, calls } = fakeRegistry();
    const { summarize } = stubSummarize();

    const result = await replaceThreadHandler(
      {
        workspaceStore: getWorkspaceStore(),
        threadStore: getThreadStore(),
        wakeupStore: getWakeupStore(),
        wakeupRegistry: canceler,
        summarize,
      },
      workspace,
    );

    expect(result.ok).to.equal(true);
    expect(calls).to.have.length(0);
  });

  it('leaves everything unmigrated when the force-summarize step throws', async () => {
    const { canceler } = fakeRegistry();
    const summarize = async () => {
      throw new Error('model unavailable');
    };

    const result = await replaceThreadHandler(
      {
        workspaceStore: getWorkspaceStore(),
        threadStore: getThreadStore(),
        wakeupStore: getWakeupStore(),
        wakeupRegistry: canceler,
        summarize,
      },
      workspace,
    );

    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(500);

    const oldMeta = getThreadStore().getThreadMeta(oldThreadId)!;
    expect(oldMeta.archivedAt).to.equal(null);
    expect(oldMeta.title).to.equal('Old Thread');

    const refreshed = getWorkspaceStore().getWorkspace(workspace.id)!;
    expect(refreshed.threadId).to.equal(oldThreadId);
  });

  it('does not fail the overall result when wake-up cancellation itself throws', async () => {
    const throwingCanceler: WakeupCanceler = {
      cancel() {
        throw new Error('registry boom');
      },
    };
    getWakeupStore().schedule({
      threadId: oldThreadId,
      note: 'check back',
      fireAt: new Date(Date.now() + 60_000),
      chainDepth: 0,
    });
    const { summarize } = stubSummarize();

    const result = await replaceThreadHandler(
      {
        workspaceStore: getWorkspaceStore(),
        threadStore: getThreadStore(),
        wakeupStore: getWakeupStore(),
        wakeupRegistry: throwingCanceler,
        summarize,
      },
      workspace,
    );

    expect(result.ok).to.equal(true);
  });
});
