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
      store.parkQueueEntry(pausedEntry.id);

      const restarted = new WorkspaceStore(db);

      expect(restarted.getTask(doneTask.id)!.status).to.equal('done');
      expect(restarted.listQueue().find((e) => e.taskId === doneTask.id)).to.equal(undefined);

      // parkQueueEntry parks the task at 'blocked' — recovery must leave a
      // non-'running' queue row (and its task) alone.
      expect(restarted.getTask(pausedTask.id)!.status).to.equal('blocked');
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

  describe('task cancel/pause/take-over queue columns (migration 26)', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-cancel-abort-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function makeRunningEntry(title = 't') {
      const task = store.createTask({ title, assignedTo: 'agent' });
      store.enqueueTask(task.id);
      return store.dequeueNext()!;
    }

    it('parkQueueEntry pauses the row with reason "user" and parks the task at "blocked"', () => {
      const entry = makeRunningEntry();
      store.parkQueueEntry(entry.id);

      const row = store.listQueue().find((e) => e.id === entry.id)!;
      expect(row.status).to.equal('paused');
      expect(row.pauseReason).to.equal('user');
      expect(row.pausedAt).to.not.equal(null);
      expect(store.getTask(entry.taskId)!.status).to.equal('blocked');
    });

    it('detachQueueEntry retires the queue row without touching the task at all', () => {
      const entry = makeRunningEntry();
      // Simulate the take-over route handler's synchronous pre-write —
      // detachQueueEntry must leave this completely alone.
      const preWrite = store.patchTask(entry.taskId, { status: 'pending', assignedTo: 'user' })!;

      store.detachQueueEntry(entry.id);

      const row = store.listQueue().find((e) => e.id === entry.id);
      expect(row).to.equal(undefined); // 'cancelled' rows drop out of listQueue()'s active filter
      expect(store.getTask(entry.taskId)).to.deep.equal(preWrite);
    });

    it('completeQueueEntry(id, "cancelled") mirrors onto both tables', () => {
      const entry = makeRunningEntry();
      store.completeQueueEntry(entry.id, 'cancelled');
      expect(store.getTask(entry.taskId)!.status).to.equal('cancelled');
    });

    it('resumePausedEntry un-pauses a parked row and leaves pauseReason/pausedAt intact', () => {
      const entry = makeRunningEntry();
      store.parkQueueEntry(entry.id);
      store.resumePausedEntry(entry.id);

      const row = store.listQueue().find((e) => e.id === entry.id)!;
      expect(row.status).to.equal('pending');
      // Left in place so task-execution.ts can detect a resumed run on the
      // next dequeue and send a continuation-flavored kickoff message.
      expect(row.pauseReason).to.equal('user');
      expect(row.pausedAt).to.not.equal(null);
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

  describe('scope-aware queue (per-workspace/per-Inbox "one running" — issue #160)', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-scope-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function makeQueuedTask(title: string, workspaceId?: string | null) {
      const task = store.createTask({ title, workspaceId, assignedTo: 'agent' });
      return store.enqueueTask(task.id);
    }

    it('dequeueNext() skips a scope with a running entry and dispatches the next eligible one instead', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const inboxFirst = makeQueuedTask('Inbox first');
      const workspaceTask = makeQueuedTask('Workspace task', workspace.id);
      makeQueuedTask('Inbox second');

      const first = store.dequeueNext()!;
      expect(first.id).to.equal(inboxFirst.id);

      // Inbox scope is now busy — the next dequeue must skip "Inbox second"
      // (position-wise the next pending row) and dispatch the workspace
      // task instead, since its scope is free.
      const second = store.dequeueNext()!;
      expect(second.id).to.equal(workspaceTask.id);

      // Both scopes are now busy — nothing left to dispatch.
      expect(store.dequeueNext()).to.equal(null);
    });

    it('getRunningEntry(scope) returns null for an unrelated scope even while another scope has a running entry', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const inboxEntry = makeQueuedTask('Inbox task');
      store.dequeueNext();

      expect(store.getRunningEntry('inbox')!.id).to.equal(inboxEntry.id);
      expect(store.getRunningEntry(workspace.id)).to.equal(null);
    });

    it('getRunningEntries() reports every currently-running entry across all scopes', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      makeQueuedTask('Inbox task');
      makeQueuedTask('Workspace task', workspace.id);

      store.dequeueNext();
      store.dequeueNext();

      const running = store.getRunningEntries();
      expect(running).to.have.length(2);
      expect(running.map((r) => r.task.title).sort()).to.deep.equal([
        'Inbox task',
        'Workspace task',
      ]);
    });
  });

  describe('sub-agent tooling columns and helpers (origin=\'agent\' — issue #161, migration 27)', () => {
    let db: ReturnType<typeof openDatabase>;
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-subagent-test-'));
      db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('defaults an ordinary task to origin=\'user\' with null parent/dispatch/role columns', () => {
      const task = store.createTask({ title: 'ordinary' });
      expect(task.origin).to.equal('user');
      expect(task.parentThreadId).to.equal(null);
      expect(task.dispatchGroupId).to.equal(null);
      expect(task.role).to.equal(null);
    });

    it('createSubAgentTask() creates an origin=\'agent\' row, ready/assigned to agent, and enqueues it', () => {
      const task = store.createSubAgentTask({
        role: 'researcher',
        goal: 'Find the answer',
        parentThreadId: 'parent-thread-1',
        dispatchGroupId: 'group-1',
      });

      expect(task.origin).to.equal('agent');
      expect(task.title).to.equal('Find the answer');
      expect(task.parentThreadId).to.equal('parent-thread-1');
      expect(task.dispatchGroupId).to.equal('group-1');
      expect(task.role).to.equal('researcher');
      expect(task.status).to.equal('ready');
      expect(task.assignedTo).to.equal('agent');

      const entry = store.listQueue().find((e) => e.taskId === task.id);
      expect(entry).to.not.equal(undefined);
      expect(entry!.status).to.equal('pending');
    });

    it('dequeueNext() dispatches an origin=\'agent\' row even while its own scope has a running entry', () => {
      // A regular Inbox task occupies the Inbox scope...
      const inboxTask = store.createTask({ title: 'inbox', assignedTo: 'agent' });
      store.patchTask(inboxTask.id, { status: 'ready' });
      store.enqueueTask(inboxTask.id);
      const runningInbox = store.dequeueNext()!;
      expect(runningInbox.taskId).to.equal(inboxTask.id);

      // ...but a sub-agent task (also workspaceId=null -> 'inbox' scope) must
      // still dequeue immediately, unblocked by the scope accounting that
      // gates ordinary tasks — see docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §2.
      const subAgentTask = store.createSubAgentTask({
        role: 'researcher',
        goal: 'sub-agent goal',
        parentThreadId: 'parent-thread-1',
        dispatchGroupId: 'group-1',
      });

      const dispatched = store.dequeueNext()!;
      expect(dispatched).to.not.equal(null);
      expect(dispatched.taskId).to.equal(subAgentTask.id);
    });

    it('getRunningEntry(scope) excludes a running origin=\'agent\' row from scope accounting', () => {
      const subAgentTask = store.createSubAgentTask({
        role: 'researcher',
        goal: 'sub-agent goal',
        parentThreadId: 'parent-thread-1',
        dispatchGroupId: 'group-1',
      });
      const entry = store.dequeueNext()!;
      expect(entry.taskId).to.equal(subAgentTask.id);

      // Even though the sub-agent's own queue row is 'running', the Inbox
      // scope must still read as free.
      expect(store.getRunningEntry('inbox')).to.equal(null);
      // getRunningEntries() (no scope filter, used for "what's running" UI)
      // still reports it.
      expect(store.getRunningEntries().map((e) => e.taskId)).to.include(subAgentTask.id);
    });

    it('countPendingSiblings() counts non-terminal siblings sharing dispatchGroupId, excluding the given task and terminal ones', () => {
      const a = store.createSubAgentTask({
        role: 'r',
        goal: 'a',
        parentThreadId: 'p',
        dispatchGroupId: 'group-x',
      });
      const b = store.createSubAgentTask({
        role: 'r',
        goal: 'b',
        parentThreadId: 'p',
        dispatchGroupId: 'group-x',
      });
      const c = store.createSubAgentTask({
        role: 'r',
        goal: 'c',
        parentThreadId: 'p',
        dispatchGroupId: 'group-x',
      });

      // All three still pending.
      expect(store.countPendingSiblings('group-x', a.id)).to.equal(2);

      // Complete b — only c remains pending alongside a.
      const bEntry = store.listQueue().find((e) => e.taskId === b.id)!;
      store.completeQueueEntry(bEntry.id, 'done');
      expect(store.countPendingSiblings('group-x', a.id)).to.equal(1);

      // Complete c too — none remain.
      const cEntry = store.listQueue().find((e) => e.taskId === c.id)!;
      store.completeQueueEntry(cEntry.id, 'failed');
      expect(store.countPendingSiblings('group-x', a.id)).to.equal(0);

      // A task from a different dispatch group never counts.
      store.createSubAgentTask({
        role: 'r',
        goal: 'unrelated',
        parentThreadId: 'p',
        dispatchGroupId: 'group-y',
      });
      expect(store.countPendingSiblings('group-x', a.id)).to.equal(0);
    });

    it('recoverRunningQueueEntries() marks an exhausted origin=\'agent\' row failed (not waiting_on_user) and queues it for notification', () => {
      const task = store.createSubAgentTask({
        role: 'researcher',
        goal: 'sub-agent goal',
        parentThreadId: 'parent-thread-1',
        dispatchGroupId: 'group-1',
      });
      store.dequeueNext(); // -> 'running'

      const afterFirstCrash = new WorkspaceStore(db); // 1st restart: retried
      expect(afterFirstCrash.getTask(task.id)!.status).to.equal('ready');
      expect(afterFirstCrash.drainPendingSubAgentCrashNotifications()).to.deep.equal([]);

      afterFirstCrash.dequeueNext(); // 2nd run -> 'running' again
      const afterSecondCrash = new WorkspaceStore(db); // 2nd restart: give up

      const recovered = afterSecondCrash.getTask(task.id)!;
      expect(recovered.status).to.equal('failed');
      expect(recovered.assignedTo).to.equal('agent'); // unlike origin='user', never escalated to 'user'

      const pending = afterSecondCrash.drainPendingSubAgentCrashNotifications();
      expect(pending.map((t) => t.id)).to.deep.equal([task.id]);
      // Draining is destructive — a second call returns nothing left.
      expect(afterSecondCrash.drainPendingSubAgentCrashNotifications()).to.deep.equal([]);
    });
  });
});
