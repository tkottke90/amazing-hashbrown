import type {
  ThreadReportData,
  ThreadStoreLike,
  ObservabilityStoreLike,
} from '@tkottke90/thread-reports';

// ---------------------------------------------------------------------------
// Store shapes
// ---------------------------------------------------------------------------
//
// These structurally mirror api/src/services/workspace-store.ts's own
// types — duplicated here (not imported), same convention
// @tkottke90/thread-reports' ThreadStoreLike and @tkottke90/workspace-reports'
// WorkspaceStoreLike use. api's real WorkspaceStore satisfies
// TaskRunReportStoreLike by structural typing; no import needed.

export interface WorkspaceLike {
  id: string;
  wikiId: string | null;
}

export interface TaskLike {
  id: string;
  title: string;
  status: string;
  origin: 'user' | 'agent';
  provider: string | null;
  model: string | null;
  // Nullable — a task created from chat, a webhook, or a cron trigger may
  // have no workspace. Only used to decide whether a wiki_mismatch anomaly
  // check applies (there's no workspace wiki to mismatch against
  // otherwise).
  workspaceId: string | null;
}

export interface TaskRunLike {
  id: string;
  runNumber: number;
  status: string;
  summary: string | null;
  recoveryAttempts: number;
  // null for a run that was never started (e.g. still queued) — its own
  // 'task'-type thread is only minted on first start.
  threadId: string | null;
}

export interface FailedRunStreakLike {
  attempts: number;
  lastSummary: string | null;
}

// A task's total count of Handed-Off Runs — not a streak, just a plain
// count (a Handed-Off Run isn't a failure, so there's no boundary to stop
// at). See api's own HandedOffRunSummary.
export interface HandedOffRunSummaryLike {
  count: number;
  lastSummary: string | null;
}

export interface TaskProgressEntryLike {
  taskId: string;
  outcome: 'done' | 'failed' | 'handed_off';
  summary: string;
  filesChanged: string[];
  commitShas: string[];
  completedAt: string;
}

export interface TaskRunReportStoreLike {
  getTask(taskId: string): TaskLike | null;
  // Only called when the task has a non-null workspaceId.
  getWorkspace(workspaceId: string): WorkspaceLike | null;
  listTaskRuns(taskId: string): TaskRunLike[];
  failedRunStreaks(taskIds: string[]): Map<string, FailedRunStreakLike>;
  handedOffRunCounts(taskIds: string[]): Map<string, HandedOffRunSummaryLike>;
  listTaskProgressEntriesForTask(taskId: string): TaskProgressEntryLike[];
}

export interface TaskRunReportStores {
  workspaceStore: TaskRunReportStoreLike;
  threadStore: ThreadStoreLike;
  observabilityStore: ObservabilityStoreLike;
}

// ---------------------------------------------------------------------------
// Report data
// ---------------------------------------------------------------------------

export interface TaskRunRetrospective {
  runId: string;
  runNumber: number;
  status: string;
  summary: string | null;
  recoveryAttempts: number;
  threadReport: ThreadReportData | null;
}

export type Anomaly =
  | {
      kind: 'repeated_failures';
      taskId: string;
      taskTitle: string;
      attempts: number;
      lastSummary: string | null;
    }
  | {
      kind: 'wiki_mismatch';
      threadId: string;
      pageTitle: string;
      pageKind: string;
      actualWikiName: string;
      expectedWikiId: string;
      at: string;
    }
  | {
      kind: 'recursion_escalation';
      threadId: string;
      taskId: string | null;
      escalationKind: string;
      question: string;
      at: string;
    };

// A task with at least one Handed-Off Run, for this report's own "Handoffs"
// signal. Deliberately NOT a 4th Anomaly variant — a handoff is a
// cooperative, user-requested stop with real progress, not a problem to
// flag alongside wiki mismatches and recursion escalations.
export interface HandoffSummary {
  taskId: string;
  taskTitle: string;
  count: number;
  lastSummary: string | null;
}

export interface TaskRunReportSummary {
  runCount: number;
  failureCount: number;
  wikiWriteCount: number;
  anomalyCount: number;
}

export interface TaskRunReportData {
  taskId: string;
  generatedAt: string;
  task: TaskLike;
  runs: TaskRunRetrospective[];
  anomalies: Anomaly[];
  handoff: HandoffSummary | null;
  progressEntries: TaskProgressEntryLike[];
  summary: TaskRunReportSummary;
  // Count of this task's runs up to and including the one that reached
  // 'done', or null when the task hasn't reached 'done' yet.
  runsToComplete: number | null;
}
