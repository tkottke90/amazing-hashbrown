import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from './workspace-store.js';

describe('services/workspace-store', () => {
  describe('recoverRunningQueueEntries() (crash recovery, runs in the constructor)', () => {
    let db: ReturnType<typeof openDatabase>;
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-test-'));
      db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('mirrors a crash-recovered queue entry back onto tasks.status', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.patchTask(task.id, { status: 'ready' });
      store.enqueueTask(task.id);
      store.dequeueNext(); // tasks.status -> 'running'

      const restarted = new WorkspaceStore(db); // simulates process restart

      expect(restarted.getTask(task.id)!.status).to.equal('ready');
      const entry = restarted.listQueue().find((e) => e.taskId === task.id)!;
      expect(entry.status).to.equal('pending');
      expect(entry.recoveryAttempts).to.equal(1);
    });

    it('escalates to waiting_on_user after a second consecutive crash', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.patchTask(task.id, { status: 'ready' });
      store.enqueueTask(task.id);
      store.dequeueNext(); // 1st run -> 'running'

      const afterFirstCrash = new WorkspaceStore(db); // 1st restart: retried
      expect(afterFirstCrash.getTask(task.id)!.status).to.equal('ready');

      afterFirstCrash.dequeueNext(); // 2nd run -> 'running' again (same queue row)
      const afterSecondCrash = new WorkspaceStore(db); // 2nd restart: give up, escalate

      const escalated = afterSecondCrash.getTask(task.id)!;
      expect(escalated.status).to.equal('waiting_on_user');
      expect(escalated.assignedTo).to.equal('user');
      // 'failed' entries are excluded from listQueue()'s active-status filter.
      expect(afterSecondCrash.listQueue().find((e) => e.taskId === task.id)).to.equal(undefined);
    });

    it('does not touch a queue entry that is done, failed, or paused at restart time', () => {
      const doneTask = store.createTask({ title: 'done', assignedTo: 'agent' });
      store.enqueueTask(doneTask.id);
      const doneEntry = store.dequeueNext()!;
      store.completeQueueEntry(doneEntry.id, 'done');

      const pausedTask = store.createTask({ title: 'paused', assignedTo: 'agent' });
      store.enqueueTask(pausedTask.id);
      const pausedEntry = store.dequeueNext()!;
      store.pauseQueueEntry(pausedEntry.id);

      const restarted = new WorkspaceStore(db);

      expect(restarted.getTask(doneTask.id)!.status).to.equal('done');
      expect(restarted.listQueue().find((e) => e.taskId === doneTask.id)).to.equal(undefined);

      expect(restarted.getTask(pausedTask.id)!.status).to.equal('running');
      const stillPaused = restarted.listQueue().find((e) => e.taskId === pausedTask.id)!;
      expect(stillPaused.status).to.equal('paused');
    });

    it('does not clobber a tasks.status that was separately patched away from running before the crash', () => {
      const task = store.createTask({ title: 't', assignedTo: 'agent' });
      store.enqueueTask(task.id);
      store.dequeueNext();
      // Simulate the task being cancelled by the user while still marked
      // running in the queue (e.g. a race with the crash itself).
      store.patchTask(task.id, { status: 'cancelled' });

      const restarted = new WorkspaceStore(db);

      expect(restarted.getTask(task.id)!.status).to.equal('cancelled');
    });
  });

  describe('workspace-chat columns (migration 23)', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-chat-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('defaults threadId/summaryPath/lastSummarizedMessageId to null on a freshly created workspace', () => {
      const ws = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      expect(ws.threadId).to.equal(null);
      expect(ws.summaryPath).to.equal(null);
      expect(ws.lastSummarizedMessageId).to.equal(null);
    });

    it('patchWorkspace can set and read back all three fields', () => {
      const ws = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const updated = store.patchWorkspace(ws.id, {
        threadId: 'thread-1',
        summaryPath: '.hashbrown/summaries/2026-08-26T00-00-00-000Z.md',
        lastSummarizedMessageId: 'msg-1',
      });
      expect(updated!.threadId).to.equal('thread-1');
      expect(updated!.summaryPath).to.equal('.hashbrown/summaries/2026-08-26T00-00-00-000Z.md');
      expect(updated!.lastSummarizedMessageId).to.equal('msg-1');

      const reloaded = store.getWorkspace(ws.id)!;
      expect(reloaded.threadId).to.equal('thread-1');
    });
  });

  describe('task automated-execution columns (migration 24)', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-task-exec-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('defaults threadId/resumeAnswer to null on a freshly created task', () => {
      const task = store.createTask({ title: 't' });
      expect(task.threadId).to.equal(null);
      expect(task.resumeAnswer).to.equal(null);
    });

    it('patchTask can set and read back both fields', () => {
      const task = store.createTask({ title: 't' });
      const updated = store.patchTask(task.id, {
        threadId: 'thread-1',
        resumeAnswer: 'yes, proceed',
      });
      expect(updated!.threadId).to.equal('thread-1');
      expect(updated!.resumeAnswer).to.equal('yes, proceed');

      const reloaded = store.getTask(task.id)!;
      expect(reloaded.threadId).to.equal('thread-1');
      expect(reloaded.resumeAnswer).to.equal('yes, proceed');
    });

    it('patchTask can clear resumeAnswer back to null', () => {
      const task = store.createTask({ title: 't' });
      store.patchTask(task.id, { resumeAnswer: 'an answer' });
      const cleared = store.patchTask(task.id, { resumeAnswer: null });
      expect(cleared!.resumeAnswer).to.equal(null);
    });
  });

  describe('project close process columns (migration 25)', () => {
    let store: WorkspaceStore;
    let dir: string;
    let projectId: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-close-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
      projectId = 'proj-1';
      store.createProject({
        id: projectId,
        name: 'P',
        location: '/tmp/p',
        winCondition: 'ship it',
      });
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('defaults closeIntent/snapshotPath/closeProgress to null on a freshly created project', () => {
      const project = store.getProject(projectId)!;
      expect(project.status).to.equal('active');
      expect(project.closeIntent).to.equal(null);
      expect(project.snapshotPath).to.equal(null);
      expect(project.closeProgress).to.equal(null);
    });

    it('closeProject moves an active project to closing and records the intent', () => {
      const project = store.closeProject(projectId, 'close');
      expect(project!.status).to.equal('closing');
      expect(project!.closeIntent).to.equal('close');
    });

    it('closeProject records abandon intent too', () => {
      const project = store.closeProject(projectId, 'abandon');
      expect(project!.closeIntent).to.equal('abandon');
    });

    it('closeProject refuses a project that is not active', () => {
      store.closeProject(projectId, 'close');
      const second = store.closeProject(projectId, 'close');
      expect(second).to.equal(null);
    });

    it('setSnapshotPath is idempotent and overwrites on a later call', () => {
      store.closeProject(projectId, 'close');
      store.setSnapshotPath(projectId, '/tmp/p/wiki-snapshot-2026-08-28');
      expect(store.getProject(projectId)!.snapshotPath).to.equal('/tmp/p/wiki-snapshot-2026-08-28');
      store.setSnapshotPath(projectId, '/tmp/p/wiki-snapshot-2026-08-29');
      expect(store.getProject(projectId)!.snapshotPath).to.equal('/tmp/p/wiki-snapshot-2026-08-29');
    });

    it('completeClose sets the terminal status, closedAt, and clears closeProgress', () => {
      store.closeProject(projectId, 'abandon');
      store.patchProject(projectId, { closeProgress: { mergeSelections: [] } });
      const closed = store.completeClose(projectId, 'abandoned');
      expect(closed!.status).to.equal('abandoned');
      expect(closed!.closedAt).to.not.equal(null);
      expect(closed!.closeProgress).to.equal(null);
    });

    it('completeClose refuses a project that is not in the closing state', () => {
      const result = store.completeClose(projectId, 'closed');
      expect(result).to.equal(null);
    });

    it('patchProject shallow-merges closeProgress across separate calls', () => {
      store.closeProject(projectId, 'close');
      store.patchProject(projectId, {
        closeProgress: { mergeSelections: [{ filename: 'a.md', targetDomainId: 'user' }] },
      });
      store.patchProject(projectId, {
        closeProgress: {
          dependencySelections: { removeNodeModules: true, removePythonEnv: false },
        },
      });
      const project = store.getProject(projectId)!;
      expect(project.closeProgress?.mergeSelections).to.deep.equal([
        { filename: 'a.md', targetDomainId: 'user' },
      ]);
      expect(project.closeProgress?.dependencySelections).to.deep.equal({
        removeNodeModules: true,
        removePythonEnv: false,
      });
    });

    it('getProjectByWikiId finds the project owning a workspace wiki_id', () => {
      store.patchWorkspace(projectId, { wikiId: 'project-proj-1' });
      const found = store.getProjectByWikiId('project-proj-1');
      expect(found?.id).to.equal(projectId);
    });

    it('getProjectByWikiId returns null for an unowned wiki id', () => {
      expect(store.getProjectByWikiId('user')).to.equal(null);
    });
  });

  describe('findWorkspaceByName()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-find-by-name-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('finds a workspace by exact name', () => {
      const ws = store.createWorkspace({ name: 'My Workspace', location: '/tmp/w' });
      expect(store.findWorkspaceByName('My Workspace')!.id).to.equal(ws.id);
    });

    it('matches case-insensitively', () => {
      const ws = store.createWorkspace({ name: 'My Workspace', location: '/tmp/w' });
      expect(store.findWorkspaceByName('MY WORKSPACE')!.id).to.equal(ws.id);
      expect(store.findWorkspaceByName('my workspace')!.id).to.equal(ws.id);
    });

    it('returns null when no workspace matches', () => {
      store.createWorkspace({ name: 'My Workspace', location: '/tmp/w' });
      expect(store.findWorkspaceByName('Someone Else')).to.equal(null);
    });
  });
});
