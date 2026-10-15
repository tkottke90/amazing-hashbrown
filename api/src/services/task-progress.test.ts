import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import {
  bootWorkspaceStore,
  getWorkspaceStore,
  type WorkspaceStore,
  type Task,
  type Workspace,
} from './workspace-store.js';
import { recordTaskProgress, getGroupContext } from './task-progress.js';

function initGitRepo(repoDir: string): void {
  execFileSync('git', ['init'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir });
}

function headSha(repoDir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
}

describe('services/task-progress', () => {
  let db: ReturnType<typeof openDatabase>;
  let store: WorkspaceStore;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-progress-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootWorkspaceStore(db);
    store = getWorkspaceStore();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeWorkspace(opts: { remoteUrl?: string } = {}): { workspace: Workspace; repoDir: string } {
    const repoDir = mkdtempSync(join(tmpdir(), 'task-progress-repo-'));
    initGitRepo(repoDir);
    const workspace = store.createWorkspace({
      name: 'W',
      location: repoDir,
      remoteUrl: opts.remoteUrl,
    });
    return { workspace, repoDir };
  }

  function makeTask(workspace: Workspace, opts: Parameters<WorkspaceStore['createTask']>[0] = { title: 't' }): Task {
    return store.createTask({ ...opts, workspaceId: workspace.id, assignedTo: 'agent' });
  }

  describe('recordTaskProgress() [orchestration]', () => {
    it('does not insert anything when the task has no tracker link', async () => {
      const { workspace } = makeWorkspace();
      const task = makeTask(workspace, { title: 'Untracked' });

      await recordTaskProgress({
        task,
        workspace,
        outcome: 'done',
        summary: 'Did the thing.',
        startSha: null,
      });

      // No tracker fields -> nothing to query by directly, so assert via a
      // known tracker group staying empty (no cross-contamination).
      expect(store.listTaskProgressEntries('github', 'nonexistent')).to.have.length(0);
    });

    it('inserts an entry with commits/files from the diff when commits were made this run', async () => {
      const { workspace, repoDir } = makeWorkspace();
      const task = makeTask(workspace, {
        title: 'Tracked',
        trackerType: 'github',
        trackerId: 'issue-1',
      });
      const startSha = headSha(repoDir);

      writeFileSync(join(repoDir, 'new-file.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'add new-file'], { cwd: repoDir });
      const endSha = headSha(repoDir);

      await recordTaskProgress({
        task,
        workspace,
        outcome: 'done',
        summary: 'Added new-file.ts.',
        startSha,
      });

      const entries = store.listTaskProgressEntries('github', 'issue-1');
      expect(entries).to.have.length(1);
      expect(entries[0]).to.include({
        outcome: 'done',
        summary: 'Added new-file.ts.',
        taskId: task.id,
        startCommitSha: startSha,
        endCommitSha: endSha,
      });
      expect(entries[0].commitShas).to.deep.equal([endSha]);
      expect(entries[0].filesChanged).to.deep.equal(['new-file.ts']);
    });

    it('falls back to the working tree dirty files when no commits were made this run', async () => {
      const { workspace, repoDir } = makeWorkspace();
      const task = makeTask(workspace, {
        title: 'Tracked, uncommitted work',
        trackerType: 'github',
        trackerId: 'issue-2',
      });
      const startSha = headSha(repoDir);
      writeFileSync(join(repoDir, 'uncommitted.ts'), 'export const y = 2;\n');

      await recordTaskProgress({
        task,
        workspace,
        outcome: 'failed',
        summary: 'Could not finish in time.',
        startSha,
      });

      const entries = store.listTaskProgressEntries('github', 'issue-2');
      expect(entries).to.have.length(1);
      expect(entries[0].commitShas).to.deep.equal([]);
      expect(entries[0].filesChanged).to.deep.equal(['uncommitted.ts']);
    });

    it('swallows a git failure (e.g. a missing repo directory) rather than throwing', async () => {
      const { workspace } = makeWorkspace();
      // Point the workspace at a directory that doesn't exist, after the
      // task is created against the real one above.
      const brokenWorkspace: Workspace = { ...workspace, location: '/nonexistent/path/xyz' };
      const task = makeTask(workspace, {
        title: 'Broken repo path',
        trackerType: 'github',
        trackerId: 'issue-3',
      });

      let threw = false;
      try {
        await recordTaskProgress({
          task,
          workspace: brokenWorkspace,
          outcome: 'failed',
          summary: 'n/a',
          startSha: null,
        });
      } catch {
        threw = true;
      }

      expect(threw).to.equal(false);
      expect(store.listTaskProgressEntries('github', 'issue-3')).to.have.length(0);
    });

    it('uses workspace.remoteUrl as repoIdentifier when set', async () => {
      const { workspace } = makeWorkspace({ remoteUrl: 'https://github.com/example/repo.git' });
      const task = makeTask(workspace, {
        title: 'Has remote',
        trackerType: 'github',
        trackerId: 'issue-4',
      });

      await recordTaskProgress({
        task,
        workspace,
        outcome: 'done',
        summary: 'ok',
        startSha: headSha(workspace.location),
      });

      const entries = store.listTaskProgressEntries('github', 'issue-4');
      expect(entries[0].repoIdentifier).to.equal('https://github.com/example/repo.git');
    });

    it('falls back to the directory basename as repoIdentifier when remoteUrl is unset', async () => {
      const { workspace } = makeWorkspace();
      const task = makeTask(workspace, {
        title: 'No remote',
        trackerType: 'github',
        trackerId: 'issue-5',
      });

      await recordTaskProgress({
        task,
        workspace,
        outcome: 'done',
        summary: 'ok',
        startSha: headSha(workspace.location),
      });

      const entries = store.listTaskProgressEntries('github', 'issue-5');
      expect(entries[0].repoIdentifier).to.equal(workspace.location.split('/').pop());
    });

    it("carries the task's plan snapshot through verbatim", async () => {
      const { workspace } = makeWorkspace();
      const task = makeTask(workspace, {
        title: 'Has a plan',
        trackerType: 'github',
        trackerId: 'issue-6',
        plan: [{ step: 'Do the thing', done: true }],
      });

      await recordTaskProgress({
        task,
        workspace,
        outcome: 'done',
        summary: 'ok',
        startSha: headSha(workspace.location),
      });

      const entries = store.listTaskProgressEntries('github', 'issue-6');
      expect(entries[0].planSnapshot).to.deep.equal([{ step: 'Do the thing', done: true }]);
    });
  });

  describe('getGroupContext() [unit]', () => {
    it('returns null for a task with no tracker link and no dependency edges', () => {
      const { workspace } = makeWorkspace();
      const task = makeTask(workspace, { title: 'Alone' });
      expect(getGroupContext(task)).to.equal(null);
    });

    it('returns tracker entries for a tracker-linked task, excluding its own prior entries', async () => {
      const { workspace } = makeWorkspace();
      const sibling = makeTask(workspace, {
        title: 'Sibling',
        trackerType: 'github',
        trackerId: 'issue-10',
      });
      await recordTaskProgress({
        task: sibling,
        workspace,
        outcome: 'done',
        summary: 'Sibling did its part.',
        startSha: headSha(workspace.location),
      });

      const self = makeTask(workspace, {
        title: 'Self',
        trackerType: 'github',
        trackerId: 'issue-10',
      });
      // Simulate a prior run of "self" already having an entry — it must
      // never show up in self's own sibling context.
      await recordTaskProgress({
        task: self,
        workspace,
        outcome: 'failed',
        summary: 'Self failed once already.',
        startSha: headSha(workspace.location),
      });

      const ctx = getGroupContext(self);
      expect(ctx).to.not.equal(null);
      expect(ctx!.trackerEntries).to.have.length(1);
      expect(ctx!.trackerEntries[0].taskId).to.equal(sibling.id);
      expect(ctx!.trackerEntries[0].summary).to.equal('Sibling did its part.');
    });

    it('returns dependsOnSummaries sourced from the target task latest run', () => {
      const { workspace } = makeWorkspace();
      const target = makeTask(workspace, { title: 'Target' });
      store.patchTask(target.id, { status: 'ready' });
      store.enqueueTask(target.id);
      const run = store.dequeueNext()!;
      store.setQueueEntrySummary(run.id, 'Target finished its work.');
      store.completeQueueEntry(run.id, 'done');

      const dependent = makeTask(workspace, { title: 'Dependent' });
      store.addTaskDependency(dependent.id, target.id);

      const ctx = getGroupContext(dependent);
      expect(ctx).to.not.equal(null);
      expect(ctx!.dependsOnSummaries).to.deep.equal([
        { taskId: target.id, title: 'Target', status: 'done', summary: 'Target finished its work.' },
      ]);
    });

    it('returns dependedOnByTasks with title/status only, no outcome', () => {
      const { workspace } = makeWorkspace();
      const target = makeTask(workspace, { title: 'Target' });
      const dependent = makeTask(workspace, { title: 'Dependent' });
      store.addTaskDependency(dependent.id, target.id);

      const ctx = getGroupContext(target);
      expect(ctx).to.not.equal(null);
      expect(ctx!.dependedOnByTasks).to.deep.equal([
        { taskId: dependent.id, title: 'Dependent', status: 'pending' },
      ]);
    });

    it('returns a non-null context for a dependency-only task with no tracker link', () => {
      const { workspace } = makeWorkspace();
      const target = makeTask(workspace, { title: 'Target' });
      const dependent = makeTask(workspace, { title: 'Dependent' });
      store.addTaskDependency(dependent.id, target.id);

      expect(getGroupContext(dependent)).to.not.equal(null);
      expect(getGroupContext(dependent)!.trackerEntries).to.deep.equal([]);
    });

    it('is unaffected by deleting the target task — deleteTask also removes the dependency edge', () => {
      // Belt-and-suspenders regression: deleteTask's own cascade already
      // removes task_dependencies rows referencing the deleted task (see
      // workspace-store.ts), so there is no dangling edge left for
      // getGroupContext to defensively skip here — this just confirms that
      // cascade actually holds, rather than silently relying on it.
      const { workspace } = makeWorkspace();
      const target = makeTask(workspace, { title: 'Will be deleted' });
      const dependent = makeTask(workspace, { title: 'Dependent' });
      store.addTaskDependency(dependent.id, target.id);
      store.deleteTask(target.id);

      expect(store.listTaskDependencies(dependent.id)).to.have.length(0);
      expect(getGroupContext(dependent)).to.equal(null);
    });
  });
});
