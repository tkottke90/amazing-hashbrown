import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from './workspace-store.js';
import { ThreadStore } from './thread-store.js';
import { checkWikiWrite, resolveWikiWriteScope } from './wiki-write-scope.js';

enum TestTypes {
  UNIT = '[unit]',
}

describe('services/wiki-write-scope', () => {
  describe('resolveWikiWriteScope()', () => {
    let dir: string;
    let workspaceStore: WorkspaceStore;
    let threadStore: ThreadStore;
    let stores: { workspaceStore: WorkspaceStore; threadStore: ThreadStore };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'wiki-write-scope-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      workspaceStore = new WorkspaceStore(db);
      threadStore = new ThreadStore(db);
      stores = { workspaceStore, threadStore };
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function workspaceWithThread(name: string, wikiId?: string) {
      const ws = workspaceStore.createWorkspace({ name, location: `/tmp/${name}`, wikiId });
      const threadId = `thread-${name}`;
      threadStore.upsertThreadOnFirstMessage(threadId, name, 'workspace-chat');
      workspaceStore.patchWorkspace(ws.id, { threadId });
      return { ws, threadId };
    }

    it(`locks a bound (non-project) workspace to its own wiki ${TestTypes.UNIT}`, () => {
      // The core of #202: binding a wiki to a plain workspace is no longer a
      // hint — it's the only place that workspace's notes may go.
      const { threadId } = workspaceWithThread('image-archive', 'image-archive');
      expect(resolveWikiWriteScope({ threadId }, stores)).to.deep.equal({
        kind: 'locked',
        wikiId: 'image-archive',
      });
    });

    it(`locks a project workspace to its project wiki ${TestTypes.UNIT}`, () => {
      workspaceStore.createProject({
        id: 'p1',
        name: 'Video Streaming',
        location: '/tmp/p1',
        winCondition: 'done',
        wikiId: 'project-p1',
      });
      threadStore.upsertThreadOnFirstMessage('thread-p1', 'p1', 'workspace-chat');
      workspaceStore.patchWorkspace('p1', { threadId: 'thread-p1' });
      expect(resolveWikiWriteScope({ threadId: 'thread-p1' }, stores)).to.deep.equal({
        kind: 'locked',
        wikiId: 'project-p1',
      });
    });

    it(`opens an unbound workspace but excludes wikis bound to other workspaces ${TestTypes.UNIT}`, () => {
      workspaceWithThread('video-streaming', 'video-streaming');
      const { threadId } = workspaceWithThread('scratch');
      expect(resolveWikiWriteScope({ threadId }, stores)).to.deep.equal({
        kind: 'open',
        excludedWikiIds: ['video-streaming'],
      });
    });

    it(`prefers a server-set workspaceId over the thread lookup ${TestTypes.UNIT}`, () => {
      // The summarizer and some headless paths only carry thread_id, but
      // workspace chat/task runs carry workspaceId too — it must win, since
      // workspace.threadId can be unset while the run is clearly scoped.
      const { ws } = workspaceWithThread('image-archive', 'image-archive');
      expect(
        resolveWikiWriteScope({ threadId: 'no-such-thread', workspaceId: ws.id }, stores),
      ).to.deep.equal({ kind: 'locked', wikiId: 'image-archive' });
    });

    it(`is unresolved when the given workspaceId does not exist ${TestTypes.UNIT}`, () => {
      expect(
        resolveWikiWriteScope({ threadId: 'anything', workspaceId: 'gone' }, stores),
      ).to.deep.equal({ kind: 'unresolved' });
    });

    it(`resolves a workspace-scoped task's own task thread to its workspace's lock ${TestTypes.UNIT}`, () => {
      // Task runs don't use the workspace-chat thread — treating every
      // 'task' thread as global would leave workspace task runs unscoped.
      const { ws } = workspaceWithThread('image-archive', 'image-archive');
      const task = workspaceStore.createTask({ title: 't', workspaceId: ws.id });
      threadStore.upsertThreadOnFirstMessage('task-thread', 't', 'task');
      workspaceStore.patchTask(task.id, { threadId: 'task-thread' });
      expect(resolveWikiWriteScope({ threadId: 'task-thread' }, stores)).to.deep.equal({
        kind: 'locked',
        wikiId: 'image-archive',
      });
    });

    it(`opens a global task's thread with no exclusions ${TestTypes.UNIT}`, () => {
      const task = workspaceStore.createTask({ title: 'global' });
      threadStore.upsertThreadOnFirstMessage('global-task-thread', 'g', 'task');
      workspaceStore.patchTask(task.id, { threadId: 'global-task-thread' });
      expect(resolveWikiWriteScope({ threadId: 'global-task-thread' }, stores)).to.deep.equal({
        kind: 'open',
        excludedWikiIds: [],
      });
    });

    it(`opens global chat and wiki threads with no exclusions ${TestTypes.UNIT}`, () => {
      workspaceWithThread('video-streaming', 'video-streaming');
      threadStore.upsertThreadOnFirstMessage('chat-thread', 'c', 'chat');
      threadStore.upsertThreadOnFirstMessage('wiki-thread', 'w', 'wiki');
      for (const threadId of ['chat-thread', 'wiki-thread']) {
        expect(resolveWikiWriteScope({ threadId }, stores)).to.deep.equal({
          kind: 'open',
          excludedWikiIds: [],
        });
      }
    });

    it(`is unresolved for a thread that does not exist ${TestTypes.UNIT}`, () => {
      expect(resolveWikiWriteScope({ threadId: 'missing' }, stores)).to.deep.equal({
        kind: 'unresolved',
      });
    });

    it(`is unresolved for a workspace-chat thread no workspace points at ${TestTypes.UNIT}`, () => {
      threadStore.upsertThreadOnFirstMessage('orphan', 'o', 'workspace-chat');
      expect(resolveWikiWriteScope({ threadId: 'orphan' }, stores)).to.deep.equal({
        kind: 'unresolved',
      });
    });

    it(`is unresolved for a task thread whose task is gone ${TestTypes.UNIT}`, () => {
      threadStore.upsertThreadOnFirstMessage('task-orphan', 't', 'task');
      expect(resolveWikiWriteScope({ threadId: 'task-orphan' }, stores)).to.deep.equal({
        kind: 'unresolved',
      });
    });
  });

  describe('checkWikiWrite()', () => {
    it(`allows only the locked wiki and reports "locked" otherwise ${TestTypes.UNIT}`, () => {
      const scope = { kind: 'locked', wikiId: 'image-archive' } as const;
      expect(checkWikiWrite(scope, 'image-archive')).to.deep.equal({ allowed: true });
      expect(checkWikiWrite(scope, 'user')).to.deep.equal({ allowed: false, reason: 'locked' });
    });

    it(`allows any non-excluded wiki in an open scope ${TestTypes.UNIT}`, () => {
      const scope = { kind: 'open', excludedWikiIds: ['video-streaming'] } as const;
      expect(checkWikiWrite(scope, 'user')).to.deep.equal({ allowed: true });
      expect(checkWikiWrite(scope, 'video-streaming')).to.deep.equal({
        allowed: false,
        reason: 'owned-by-another-workspace',
      });
    });

    it(`denies every wiki when the scope is unresolved (fails closed) ${TestTypes.UNIT}`, () => {
      expect(checkWikiWrite({ kind: 'unresolved' }, 'user')).to.deep.equal({
        allowed: false,
        reason: 'unresolved',
      });
    });
  });
});
