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

  describe('scope guard vs. a paused (waiting_on_user) task in the same scope', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-scope-pause-test-'));
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

    // Reproduces the reported cascading-failure bug: task-execution.ts's
    // interrupt (HITL approval) path closes the queue row ('done') before
    // the task itself settles at 'waiting_on_user' — see that file's
    // `store.completeQueueEntry(entry.id, 'done')` immediately followed by
    // `store.patchTask(task.id, { status: 'waiting_on_user', ... })`. Until
    // the fix, dequeueNext()'s scope-occupancy check only looks at
    // task_queue.status = 'running', so it reads the workspace scope as free
    // the instant that queue row closes — even though the task is only
    // paused, not actually finished — and immediately dispatches the next
    // queued task onto the *same* workspace thread the paused task is still
    // mid-conversation on.
    it('does not dequeue a second task in the same workspace while the first is waiting_on_user', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const first = makeQueuedTask('First task', workspace.id);
      makeQueuedTask('Second task', workspace.id);

      const dequeued = store.dequeueNext()!;
      expect(dequeued.id).to.equal(first.id);

      // Mirrors task-execution.ts's interrupt path exactly: the queue row
      // closes out even though the task is only pausing, not finishing.
      store.completeQueueEntry(dequeued.id, 'done');
      store.patchTask(dequeued.taskId, { status: 'waiting_on_user', assignedTo: 'user' });

      // The workspace scope must still read as occupied — "Second task"
      // must not be dispatched onto the same thread while "First task" is
      // still mid-approval, unresolved.
      expect(store.dequeueNext()).to.equal(null);
    });

    it('frees the scope again once the paused task is actually resumed and completes', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const first = makeQueuedTask('First task', workspace.id);
      const second = makeQueuedTask('Second task', workspace.id);

      const dequeued = store.dequeueNext()!;
      expect(dequeued.id).to.equal(first.id);
      store.completeQueueEntry(dequeued.id, 'done');
      store.patchTask(dequeued.taskId, { status: 'waiting_on_user', assignedTo: 'user' });
      expect(store.dequeueNext()).to.equal(null);

      // The user answers the approval prompt — mirrors the /hitl route's
      // task re-enqueue branch (workspace-chat.route.ts): the task goes
      // back to 'ready'/'agent' and a fresh queue row is enqueued.
      store.patchTask(dequeued.taskId, { status: 'ready', assignedTo: 'agent' });
      const resumed = store.enqueueTask(dequeued.taskId);

      // Now that the paused task is no longer waiting_on_user, the scope is
      // free again — one of the two pending rows (resumed "First task" or
      // still-queued "Second task") should dispatch.
      const next = store.dequeueNext()!;
      expect([resumed.id, second.id]).to.include(next.id);
    });
  });

  describe('HITL park/resume (parkQueueEntryForHitl / resumePausedEntry) — no queue-position starvation', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-hitl-park-test-'));
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

    it('parks the row (paused, pause_reason chat) and lands the task at waiting_on_user, not blocked', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const entry = makeQueuedTask('Task', workspace.id);
      const dequeued = store.dequeueNext()!;
      expect(dequeued.id).to.equal(entry.id);

      store.parkQueueEntryForHitl(dequeued.id);

      const task = store.getTask(dequeued.taskId)!;
      expect(task.status).to.equal('waiting_on_user');
      expect(task.assignedTo).to.equal('user');

      const queueEntry = store.listQueue().find((q) => q.id === dequeued.id)!;
      expect(queueEntry.status).to.equal('paused');
      expect(queueEntry.pauseReason).to.equal('chat');
    });

    it('does not release a pending dependent — waiting_on_user satisfies no dependency edge, not even whileBlocked', () => {
      const a = store.createTask({ title: 'a', assignedTo: 'agent' });
      store.patchTask(a.id, { status: 'ready' });
      const entry = store.enqueueTask(a.id);
      const b = store.createTask({ title: 'b' }); // stays 'pending'
      store.addTaskDependency(b.id, a.id, { whileBlocked: true });

      store.dequeueNext();
      store.parkQueueEntryForHitl(entry.id);

      expect(store.getTask(b.id)!.status).to.equal('pending');
    });

    it("a HITL-parked task keeps its original queue position across resume — a later sibling can't cut in front of it", () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const first = makeQueuedTask('First task', workspace.id);
      const second = makeQueuedTask('Second task', workspace.id);

      const dequeued = store.dequeueNext()!;
      expect(dequeued.id).to.equal(first.id);

      // First task hits an approval interrupt.
      store.parkQueueEntryForHitl(dequeued.id);
      expect(store.dequeueNext()).to.equal(null); // scope still occupied

      // The human answers the prompt — mirrors the /hitl route's task
      // branch (workspace-chat.route.ts), minus resumeAnswer, which this
      // store-level test has no reason to thread through.
      store.patchTask(dequeued.taskId, { status: 'ready', assignedTo: 'agent' });
      store.resumePausedEntry(dequeued.id);

      // The SAME row, at its original position, is what comes back — not a
      // fresh row appended behind "Second task".
      const next = store.dequeueNext()!;
      expect(next.id).to.equal(dequeued.id);
      expect(next.id).not.to.equal(second.id);
    });

    it('contrast: the old completeQueueEntry + enqueueTask pattern lets a later sibling starve the resumed task', () => {
      const workspace = store.createWorkspace({ name: 'W', location: '/tmp/w' });
      const first = makeQueuedTask('First task', workspace.id);
      const second = makeQueuedTask('Second task', workspace.id);

      const dequeued = store.dequeueNext()!;
      store.completeQueueEntry(dequeued.id, 'done');
      store.patchTask(dequeued.taskId, { status: 'waiting_on_user', assignedTo: 'user' });

      store.patchTask(dequeued.taskId, { status: 'ready', assignedTo: 'agent' });
      const resumedEntry = store.enqueueTask(dequeued.taskId); // fresh row, back of the queue

      // "Second task"'s original (earlier) position beats the resumed
      // task's brand-new (later) one — this is the starvation bug.
      const next = store.dequeueNext()!;
      expect(next.id).to.equal(second.id);
      expect(next.id).not.to.equal(resumedEntry.id);
    });
  });

  describe("sub-agent tooling columns and helpers (origin='agent' — issue #161, migration 27)", () => {
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

    it("defaults an ordinary task to origin='user' with null parent/dispatch/role columns", () => {
      const task = store.createTask({ title: 'ordinary' });
      expect(task.origin).to.equal('user');
      expect(task.parentThreadId).to.equal(null);
      expect(task.dispatchGroupId).to.equal(null);
      expect(task.role).to.equal(null);
    });

    it("createSubAgentTask() creates an origin='agent' row, ready/assigned to agent, and enqueues it", () => {
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

    it("dequeueNext() dispatches an origin='agent' row even while its own scope has a running entry", () => {
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

    it("getRunningEntry(scope) excludes a running origin='agent' row from scope accounting", () => {
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

    it("recoverRunningQueueEntries() marks an exhausted origin='agent' row failed (not waiting_on_user) and queues it for notification", () => {
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

  describe('createTasks() (batch task creation for the create_tasks agent tool)', () => {
    let db: ReturnType<typeof openDatabase>;
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-create-tasks-test-'));
      db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('creates every row ready/assigned to agent, each with its own queue entry', () => {
      const tasks = store.createTasks([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);

      expect(tasks).to.have.length(3);
      for (const task of tasks) {
        expect(task.status).to.equal('ready');
        expect(task.assignedTo).to.equal('agent');
        const entry = store.listQueue().find((e) => e.taskId === task.id);
        expect(entry).to.not.equal(undefined);
        expect(entry!.status).to.equal('pending');
      }
    });

    it('returns rows in input order, not insertion/alphabetical order', () => {
      const tasks = store.createTasks([{ title: 'c' }, { title: 'a' }, { title: 'b' }]);
      expect(tasks.map((t) => t.title)).to.deep.equal(['c', 'a', 'b']);
    });

    it('round-trips a plan checklist through JSON storage', () => {
      const [task] = store.createTasks([
        { title: 'with plan', plan: [{ step: 'write code', done: false }] },
      ]);
      expect(task.plan).to.deep.equal([{ step: 'write code', done: false }]);
    });

    it('stamps tracker fields onto the created row', () => {
      const [task] = store.createTasks([
        { title: 'linked', trackerType: 'github', trackerId: 'owner/repo#42' },
      ]);
      expect(task.trackerType).to.equal('github');
      expect(task.trackerId).to.equal('owner/repo#42');
    });

    it('rolls back the entire batch if any row fails to insert (atomicity)', () => {
      expect(() =>
        store.createTasks([
          { title: 'first' },
          { title: 'second', workspaceId: 'does-not-exist' }, // FK violation
          { title: 'third' },
        ]),
      ).to.throw();

      expect(store.listTasks({})).to.deep.equal([]);
      expect(store.listQueue()).to.deep.equal([]);
    });

    it('leaves a task with dependsOnIndexes at pending instead of ready/enqueued', () => {
      const [first, second] = store.createTasks([
        { title: 'first' },
        { title: 'second', dependsOnIndexes: [0] },
      ]);

      expect(first!.status).to.equal('ready');
      expect(second!.status).to.equal('pending');
      expect(store.listQueue().some((e) => e.taskId === second!.id)).to.equal(false);
      const deps = store.listTaskDependencies(second!.id);
      expect(deps).to.have.length(1);
      expect(deps[0]!.dependsOnTaskId).to.equal(first!.id);
    });

    it('rolls back the whole batch if a dependsOnIndexes entry is not an earlier index', () => {
      expect(() =>
        store.createTasks([
          { title: 'first', dependsOnIndexes: [1] }, // forward reference
          { title: 'second' },
        ]),
      ).to.throw(/earlier task/);

      expect(store.listTasks({})).to.deep.equal([]);
    });

    it('rolls back the whole batch if a dependsOnIndexes entry references itself', () => {
      expect(() => store.createTasks([{ title: 'first', dependsOnIndexes: [0] }])).to.throw(
        /earlier task/,
      );

      expect(store.listTasks({})).to.deep.equal([]);
    });
  });

  describe('task dependencies (schema, CRUD, gating)', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-store-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('round-trips a dependency through add/list/remove', () => {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });

      const dep = store.addTaskDependency(b.id, a.id, {
        requireSuccess: false,
        whileBlocked: true,
      });
      expect(dep.taskId).to.equal(b.id);
      expect(dep.dependsOnTaskId).to.equal(a.id);
      expect(dep.requireSuccess).to.equal(false);
      expect(dep.whileBlocked).to.equal(true);

      expect(store.listTaskDependencies(b.id).map((d) => d.id)).to.deep.equal([dep.id]);
      expect(store.listDependents(a.id).map((d) => d.id)).to.deep.equal([dep.id]);

      store.removeTaskDependency(dep.id);
      expect(store.listTaskDependencies(b.id)).to.deep.equal([]);
      expect(store.listDependents(a.id)).to.deep.equal([]);
    });

    it('defaults to requireSuccess=true, whileBlocked=false when opts are omitted', () => {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });
      const dep = store.addTaskDependency(b.id, a.id);
      expect(dep.requireSuccess).to.equal(true);
      expect(dep.whileBlocked).to.equal(false);
    });

    describe('isTaskReady()', () => {
      it('requireSuccess=true: satisfied only when the target is done', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: true });

        expect(store.isTaskReady(b.id)).to.equal(false); // a is still 'pending'

        store.patchTask(a.id, { status: 'blocked' });
        expect(store.isTaskReady(b.id)).to.equal(false); // blocked doesn't count without whileBlocked

        store.patchTask(a.id, { status: 'failed' });
        expect(store.isTaskReady(b.id)).to.equal(false); // failed never satisfies requireSuccess

        store.patchTask(a.id, { status: 'done' });
        expect(store.isTaskReady(b.id)).to.equal(true);
      });

      it('requireSuccess=false: satisfied by any terminal state', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: false });

        expect(store.isTaskReady(b.id)).to.equal(false);

        for (const status of ['done', 'failed', 'cancelled'] as const) {
          store.patchTask(a.id, { status });
          expect(store.isTaskReady(b.id), `status=${status}`).to.equal(true);
        }

        store.patchTask(a.id, { status: 'blocked' });
        expect(store.isTaskReady(b.id)).to.equal(false); // not terminal
      });

      it('whileBlocked=true: the target reaching blocked also satisfies the edge', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: true, whileBlocked: true });

        store.patchTask(a.id, { status: 'blocked' });
        expect(store.isTaskReady(b.id)).to.equal(true);

        store.patchTask(a.id, { status: 'failed' });
        expect(store.isTaskReady(b.id)).to.equal(false); // whileBlocked never rescues failed
      });

      it('requires every edge to be satisfied (AND across multiple dependencies)', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        const c = store.createTask({ title: 'c' });
        store.addTaskDependency(c.id, a.id);
        store.addTaskDependency(c.id, b.id);

        store.patchTask(a.id, { status: 'done' });
        expect(store.isTaskReady(c.id)).to.equal(false); // b not done yet

        store.patchTask(b.id, { status: 'done' });
        expect(store.isTaskReady(c.id)).to.equal(true);
      });
    });

    describe('hasBrokenDependency()', () => {
      it('is true when a requireSuccess target fails or is cancelled', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: true });

        expect(store.hasBrokenDependency(b.id)).to.equal(false);
        store.patchTask(a.id, { status: 'failed' });
        expect(store.hasBrokenDependency(b.id)).to.equal(true);
      });

      it('is false when requireSuccess is false, even if the target fails', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: false });

        store.patchTask(a.id, { status: 'failed' });
        expect(store.hasBrokenDependency(b.id)).to.equal(false);
      });
    });

    describe('releaseEligibleDependents() via completeQueueEntry/parkQueueEntry', () => {
      it('auto-readies and enqueues a pending dependent once its dependency completes successfully', () => {
        const a = store.createTask({ title: 'a', assignedTo: 'agent' });
        store.patchTask(a.id, { status: 'ready' });
        const entry = store.enqueueTask(a.id);
        const b = store.createTask({ title: 'b' }); // stays 'pending'
        store.addTaskDependency(b.id, a.id);

        store.completeQueueEntry(entry.id, 'done');

        const updatedB = store.getTask(b.id)!;
        expect(updatedB.status).to.equal('ready');
        expect(updatedB.assignedTo).to.equal('agent');
        expect(store.listQueue().some((q) => q.taskId === b.id)).to.equal(true);
      });

      it('auto-blocks a pending dependent (with a reason) when its required dependency fails', () => {
        const a = store.createTask({ title: 'a', assignedTo: 'agent' });
        store.patchTask(a.id, { status: 'ready' });
        const entry = store.enqueueTask(a.id);
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: true });

        store.completeQueueEntry(entry.id, 'failed');

        const updatedB = store.getTask(b.id)!;
        expect(updatedB.status).to.equal('blocked');
        expect(updatedB.blockedReason).to.equal('dependency_failed');
        expect(store.listQueue().some((q) => q.taskId === b.id)).to.equal(false);
      });

      it('leaves a pending dependent alone when its dependency merely fails and requireSuccess is false', () => {
        const a = store.createTask({ title: 'a', assignedTo: 'agent' });
        store.patchTask(a.id, { status: 'ready' });
        const entry = store.enqueueTask(a.id);
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { requireSuccess: false });

        store.completeQueueEntry(entry.id, 'failed');

        const updatedB = store.getTask(b.id)!;
        expect(updatedB.status).to.equal('ready'); // satisfied: any terminal state
      });

      it('releases a whileBlocked dependent when its dependency is paused, via parkQueueEntry', () => {
        const a = store.createTask({ title: 'a', assignedTo: 'agent' });
        store.patchTask(a.id, { status: 'ready' });
        const entry = store.enqueueTask(a.id);
        store.dequeueNext(); // a -> running, entry -> running
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id, { whileBlocked: true });

        store.parkQueueEntry(entry.id);

        expect(store.getTask(a.id)!.status).to.equal('blocked');
        const updatedB = store.getTask(b.id)!;
        expect(updatedB.status).to.equal('ready');
      });

      it('leaves an already-released (non-pending) dependent untouched', () => {
        const a = store.createTask({ title: 'a', assignedTo: 'agent' });
        store.patchTask(a.id, { status: 'ready' });
        const entryA = store.enqueueTask(a.id);
        const b = store.createTask({ title: 'b', assignedTo: 'agent' });
        store.patchTask(b.id, { status: 'running' }); // not 'pending' anymore
        store.addTaskDependency(b.id, a.id);

        store.completeQueueEntry(entryA.id, 'done');

        expect(store.getTask(b.id)!.status).to.equal('running'); // untouched
      });
    });

    describe('deletion cascade', () => {
      it('deleteTask removes dependency rows on either side', () => {
        const a = store.createTask({ title: 'a' });
        const b = store.createTask({ title: 'b' });
        store.addTaskDependency(b.id, a.id);

        store.deleteTask(a.id);

        expect(store.listDependents(a.id)).to.deep.equal([]);
        expect(store.listTaskDependencies(b.id)).to.deep.equal([]);
      });

      it('deleteWorkspace removes dependency rows between tasks in that workspace', () => {
        const ws = store.createWorkspace({ name: 'W', location: '/tmp/w' });
        const a = store.createTask({ title: 'a', workspaceId: ws.id });
        const b = store.createTask({ title: 'b', workspaceId: ws.id });
        store.addTaskDependency(b.id, a.id);

        store.deleteWorkspace(ws.id);

        expect(store.listDependents(a.id)).to.deep.equal([]);
      });
    });
  });
});
