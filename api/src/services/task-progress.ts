import path from 'node:path';
import { logger, serializeError } from '../config/logger.js';
import {
  getWorkspaceStore,
  type Task,
  type TaskStatus,
  type TaskProgressEntry,
  type Workspace,
} from './workspace-store.js';
import {
  getHeadCommit,
  getChangedFiles,
  getCommitsBetween,
  getDirtyFiles,
} from './workspace-git.js';

// Single-owner service for the shared task progress record — issue #302.
// See docs/superpowers/specs/2026-10-15-shared-task-progress-record-design.md.

export interface RecordTaskProgressParams {
  task: Task;
  workspace: Workspace;
  outcome: 'done' | 'failed';
  summary: string;
  // HEAD at this run's start, captured by task-execution.ts before the
  // model runs — null for an unborn-HEAD repo (no commits yet).
  startSha: string | null;
}

// Best-effort, append-only write — called from every terminal-outcome
// branch in task-execution.ts (not just the explicit complete_task path).
// Never throws: a progress-recording failure must never fail the task's own
// completion, which is already settled by the time this runs.
export async function recordTaskProgress(params: RecordTaskProgressParams): Promise<void> {
  const { task, workspace, outcome, summary, startSha } = params;
  if (!task.trackerType || !task.trackerId) return; // no tracker link, nothing to record

  try {
    const store = getWorkspaceStore();
    const endSha = await getHeadCommit(workspace.location);

    let commitShas: string[] = [];
    let filesChanged: string[] = [];
    if (endSha !== null && startSha !== endSha) {
      commitShas = await getCommitsBetween(workspace.location, startSha, endSha);
      filesChanged = await getChangedFiles(workspace.location, startSha, endSha);
    } else {
      // No commits made this run (endSha is null — still unborn HEAD — or
      // identical to startSha) — commitShas stays [], but uncommitted work
      // should still show up, so fall back to the working tree's dirty
      // files instead of leaving filesChanged empty.
      filesChanged = await getDirtyFiles(workspace.location);
    }

    const repoIdentifier = workspace.remoteUrl ?? path.basename(workspace.location);

    store.insertTaskProgressEntry({
      trackerType: task.trackerType,
      trackerId: task.trackerId,
      taskId: task.id,
      taskTitle: task.title,
      workspaceId: workspace.id,
      repoIdentifier,
      startCommitSha: startSha,
      endCommitSha: endSha,
      commitShas,
      filesChanged,
      planSnapshot: task.plan,
      outcome,
      summary,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('task-progress: failed to record progress entry', {
      taskId: task.id,
      err: serializeError(err),
    });
  }
}

export interface SiblingProgressContext {
  trackerEntries: TaskProgressEntry[];
  dependsOnSummaries: {
    taskId: string;
    title: string;
    status: TaskStatus;
    summary: string | null;
  }[];
  dependedOnByTasks: { taskId: string; title: string; status: TaskStatus }[];
}

// Pure lookup (synchronous store reads only, no git/model calls), called at
// kickoff time. Returns null when there is nothing to show (no tracker link
// AND no dependency edges in either direction) — a task with no
// relationships gets no new kickoff content, matching today's behavior.
// Can throw (e.g. a corrupt stored-JSON row) — callers must catch and
// degrade to null rather than failing the task's kickoff.
export function getGroupContext(task: Task): SiblingProgressContext | null {
  const store = getWorkspaceStore();

  const trackerEntries =
    task.trackerType && task.trackerId
      ? store.listTaskProgressEntries(task.trackerType, task.trackerId, task.id)
      : [];

  const dependsOnSummaries = store.listTaskDependencies(task.id).flatMap((dep) => {
    const target = store.getTask(dep.dependsOnTaskId);
    if (!target) return [];
    const latestRun = store.listTaskRuns(dep.dependsOnTaskId, { limit: 1 })[0];
    return [
      {
        taskId: target.id,
        title: target.title,
        status: target.status,
        summary: latestRun?.summary ?? null,
      },
    ];
  });

  const dependedOnByTasks = store.listDependents(task.id).flatMap((dep) => {
    const dependent = store.getTask(dep.taskId);
    return dependent
      ? [{ taskId: dependent.id, title: dependent.title, status: dependent.status }]
      : [];
  });

  if (
    trackerEntries.length === 0 &&
    dependsOnSummaries.length === 0 &&
    dependedOnByTasks.length === 0
  ) {
    return null;
  }
  return { trackerEntries, dependsOnSummaries, dependedOnByTasks };
}
