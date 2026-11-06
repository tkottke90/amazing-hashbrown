import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { configManager } from '../config/env.js';
import { ThreadStore } from '../services/thread-store.js';
import { WorkspaceStore, type TaskRun } from '../services/workspace-store.js';
import { bootObservability } from '../services/observability.js';
import { summarizeExhaustedRun } from './exhausted-run-summarizer.js';

class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

describe('agents/exhausted-run-summarizer', () => {
  let dir: string;
  let threadStore: ThreadStore;
  let workspaceStore: WorkspaceStore;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'exhausted-run-summarizer-test-'));
    threadStore = new ThreadStore(openDatabase(join(dir, 'threads.db')));
    workspaceStore = new WorkspaceStore(openDatabase(join(dir, 'workspaces.db')));
    bootObservability(openDatabase(join(dir, 'observability.db')));

    // summarizeExhaustedRun resolves the trace's provider/model through
    // resolveTurnModel(), which calls resolveProviderConfig() even though
    // `model` is always a directly-injected fake here.
    configManager.set('providers', [
      {
        name: 'local',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'test-model',
      },
    ]);
    configManager.set('defaultProvider', 'local');
  });

  after(() => {
    threadStore.close();
    rmSync(dir, { recursive: true, force: true });
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  let priorRun: TaskRun;

  beforeEach(() => {
    const task = workspaceStore.createTask({ title: 'Fix the flaky test', assignedTo: 'agent' });
    workspaceStore.patchTask(task.id, { status: 'ready' });
    const entry = workspaceStore.enqueueTask(task.id);
    const threadId = randomUUID();
    threadStore.upsertThreadOnFirstMessage(threadId, 'placeholder', 'task');
    workspaceStore.setQueueEntryThread(entry.id, threadId);
    workspaceStore.setQueueEntryFailureReason(entry.id, 'out_of_steps');
    workspaceStore.completeQueueEntry(entry.id, 'failed');
    priorRun = workspaceStore.getTaskRun(entry.id)!;

    threadStore.insertMessage(threadId, { id: 'u1', kind: 'user', payload: { content: 'Go.' } });
    threadStore.insertMessage(threadId, {
      id: 'a1',
      kind: 'assistant',
      payload: { content: 'Tried rewriting the comparator; it still flakes under load.' },
    });
  });

  it('condenses the prior run transcript into a short summary [unit]', async () => {
    const model = new FakeListChatModel({
      responses: ['Rewrote the comparator; the race is actually in the setup fixture.'],
    });

    const result = await summarizeExhaustedRun(threadStore, model, undefined, undefined, priorRun);

    expect(result).to.equal('Rewrote the comparator; the race is actually in the setup fixture.');
  });

  it('returns null, never throws, when the model call fails [unit]', async () => {
    const result = await summarizeExhaustedRun(
      threadStore,
      new ThrowingChatModel({}),
      undefined,
      undefined,
      priorRun,
    );

    expect(result).to.equal(null);
  });

  it('returns null when the run has no transcript to summarize [unit]', async () => {
    const task = workspaceStore.createTask({ title: 'Empty run', assignedTo: 'agent' });
    workspaceStore.patchTask(task.id, { status: 'ready' });
    const entry = workspaceStore.enqueueTask(task.id);
    const threadId = randomUUID();
    threadStore.upsertThreadOnFirstMessage(threadId, 'placeholder', 'task');
    workspaceStore.setQueueEntryThread(entry.id, threadId);
    workspaceStore.setQueueEntryFailureReason(entry.id, 'turn_overflow');
    workspaceStore.completeQueueEntry(entry.id, 'failed');
    const emptyRun = workspaceStore.getTaskRun(entry.id)!;
    const model = new FakeListChatModel({ responses: ['should never be reached'] });

    const result = await summarizeExhaustedRun(threadStore, model, undefined, undefined, emptyRun);

    expect(result).to.equal(null);
  });
});
