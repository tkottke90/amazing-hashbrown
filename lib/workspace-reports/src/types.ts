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

export interface TaskLike {
  id: string;
  title: string;
  status: string;
  origin: 'user' | 'agent';
  provider: string | null;
  model: string | null;
  trackerType: string | null;
  trackerId: string | null;
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

export interface TaskProgressEntryLike {
  taskId: string;
  outcome: 'done' | 'failed';
  summary: string;
  filesChanged: string[];
  commitShas: string[];
  completedAt: string;
}

export interface WorkspaceStoreLike {
  getWorkspace(workspaceId: string): WorkspaceLike | null;
  listTasks(filters: { workspaceId: string }): TaskLike[];
  listTaskRuns(taskId: string): TaskRunLike[];
  failedRunStreaks(taskIds: string[]): Map<string, FailedRunStreakLike>;
  listTaskProgressEntriesForWorkspace(workspaceId: string): TaskProgressEntryLike[];
}

export interface WorkspaceReportStores {
  workspaceStore: WorkspaceStoreLike;
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

export interface TaskRetrospective {
  taskId: string;
  title: string;
  status: string;
  origin: 'user' | 'agent';
  provider: string | null;
  model: string | null;
  runs: TaskRunRetrospective[];
  progressEntries: TaskProgressEntryLike[];
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

export interface WorkspaceRetrospectiveSummary {
  taskCount: number;
  runCount: number;
  failureCount: number;
  wikiWriteCount: number;
  anomalyCount: number;
}

export interface WorkspaceRetrospectiveData {
  workspaceId: string;
  generatedAt: string;
  workspace: WorkspaceLike;
  chat: ThreadReportData | null;
  tasks: TaskRetrospective[];
  anomalies: Anomaly[];
  summary: WorkspaceRetrospectiveSummary;
  // Prose written by a one-shot LLM call over this same evidence — built and
  // injected by the api-side caller (this package has no model/provider
  // dependency of its own). null when the caller skipped or the call failed.
  narrative: string | null;
}
