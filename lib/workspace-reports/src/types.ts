import type {
  ThreadReportData,
  ThreadStoreLike,
  ObservabilityStoreLike,
} from '@tkottke90/thread-reports';
import type {
  TaskLike as TaskRunReportTaskLike,
  TaskRunLike,
  FailedRunStreakLike,
  HandedOffRunSummaryLike,
  TaskProgressEntryLike,
  TaskRunRetrospective,
  Anomaly,
  HandoffSummary,
} from '@tkottke90/task-run-reports';

export type {
  TaskRunLike,
  FailedRunStreakLike,
  HandedOffRunSummaryLike,
  TaskProgressEntryLike,
  TaskRunRetrospective,
  Anomaly,
  HandoffSummary,
};

// ---------------------------------------------------------------------------
// Store shapes
// ---------------------------------------------------------------------------
//
// These structurally mirror api/src/services/workspace-store.ts's own
// types — duplicated here (not imported) so this package stays independent
// of api-internal code, same convention @tkottke90/thread-reports uses for
// ThreadStoreLike. api's real WorkspaceStore satisfies WorkspaceStoreLike by
// structural typing; no import needed.

export interface WorkspaceLike {
  id: string;
  name: string;
  goal: string | null;
  wikiId: string | null;
  threadId: string | null;
  createdAt: string;
}

// Adds workspaceId on top of @tkottke90/task-run-reports' own TaskLike (not
// imported directly — this package's build.ts still reads title/status/
// origin/provider/model off a task the same way it always has) so that the
// real WorkspaceStore.getTask() stays assignable everywhere this package
// passes `stores` straight through to buildTaskRunReport().
export interface TaskLike extends TaskRunReportTaskLike {
  trackerType: string | null;
  trackerId: string | null;
}

export interface WorkspaceStoreLike {
  getWorkspace(workspaceId: string): WorkspaceLike | null;
  getTask(taskId: string): TaskLike | null;
  listTasks(filters: { workspaceId: string }): TaskLike[];
  listTaskRuns(taskId: string): TaskRunLike[];
  failedRunStreaks(taskIds: string[]): Map<string, FailedRunStreakLike>;
  handedOffRunCounts(taskIds: string[]): Map<string, HandedOffRunSummaryLike>;
  listTaskProgressEntriesForTask(taskId: string): TaskProgressEntryLike[];
}

export interface WorkspaceReportStores {
  workspaceStore: WorkspaceStoreLike;
  threadStore: ThreadStoreLike;
  observabilityStore: ObservabilityStoreLike;
}

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

export interface TaskRetrospective {
  taskId: string;
  title: string;
  status: string;
  origin: 'user' | 'agent';
  provider: string | null;
  model: string | null;
  runs: TaskRunRetrospective[];
  progressEntries: TaskProgressEntryLike[];
  // Count of this task's runs up to and including the one that reached
  // 'done', or null when the task hasn't reached 'done' yet. Composed
  // straight from @tkottke90/task-run-reports' own TaskRunReportData.
  runsToComplete: number | null;
}

export interface WorkspaceRetrospectiveSummary {
  taskCount: number;
  runCount: number;
  failureCount: number;
  wikiWriteCount: number;
  anomalyCount: number;
  handoffCount: number;
}

export interface WorkspaceRetrospectiveData {
  workspaceId: string;
  generatedAt: string;
  workspace: WorkspaceLike;
  chat: ThreadReportData | null;
  tasks: TaskRetrospective[];
  anomalies: Anomaly[];
  handoffs: HandoffSummary[];
  summary: WorkspaceRetrospectiveSummary;
  // Prose written by a one-shot LLM call over this same evidence — built and
  // injected by the api-side caller (this package has no model/provider
  // dependency of its own). null when the caller skipped or the call failed.
  narrative: string | null;
}
