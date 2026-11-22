import { buildThreadReport } from '@tkottke90/thread-reports';
import type { ThreadReportData, HitlPromptPayload } from '@tkottke90/thread-reports';
import type {
  TaskRunReportData,
  TaskRunReportStores,
  Anomaly,
  HandoffSummary,
  TaskRunRetrospective,
} from './types.js';

export interface BuildTaskRunReportOptions {
  recursionLimit?: number;
  recursionWarnThreshold?: number;
}

// The two HITL prompt kinds recursion-guard.middleware.ts raises when a run
// gets a check-in interrupt — see api/src/agents/recursion-guard.middleware.ts.
const RECURSION_ESCALATION_KINDS = new Set(['recursion_limit_warning', 'loop_stagnation_warning']);

function findRecursionEscalations(report: ThreadReportData, taskId: string): Anomaly[] {
  const out: Anomaly[] = [];
  for (const m of report.thread.messages) {
    if (m.kind !== 'hitl_prompt') continue;
    const payload = m.payload as HitlPromptPayload;
    if (!RECURSION_ESCALATION_KINDS.has(payload.kind)) continue;
    out.push({
      kind: 'recursion_escalation',
      threadId: report.threadId,
      taskId,
      escalationKind: payload.kind,
      question: payload.question,
      at: m.createdAt,
    });
  }
  return out;
}

// after-agent.ts writes wiki_update's wikiName as the domain entry's own id
// (the same id space as workspace.wikiId), so a plain string comparison is
// enough to flag a write that landed outside the task's own workspace wiki.
function findWikiMismatches(report: ThreadReportData, expectedWikiId: string | null): Anomaly[] {
  if (!expectedWikiId) return [];
  const out: Anomaly[] = [];
  for (const event of report.timeline) {
    if (event.kind !== 'wiki_update') continue;
    if (event.wikiName === expectedWikiId) continue;
    out.push({
      kind: 'wiki_mismatch',
      threadId: report.threadId,
      pageTitle: event.pageTitle,
      pageKind: event.pageKind,
      actualWikiName: event.wikiName,
      expectedWikiId,
      at: event.at,
    });
  }
  return out;
}

function anomalySortKey(anomaly: Anomaly): string {
  return anomaly.kind === 'repeated_failures' ? '' : anomaly.at;
}

// Composes @tkottke90/thread-reports' buildThreadReport per run thread
// rather than re-deriving message/trace aggregation here — see AGENTS.md's
// "Composition over Customization" principle. Returns null only when the
// task itself doesn't exist; a task with no runs yet still produces a
// (mostly empty) report. Works for any task regardless of whether it
// belongs to a workspace.
export function buildTaskRunReport(
  taskId: string,
  stores: TaskRunReportStores,
  options: BuildTaskRunReportOptions = {},
): TaskRunReportData | null {
  const task = stores.workspaceStore.getTask(taskId);
  if (!task) return null;

  const reportOptions = {
    recursionLimit: options.recursionLimit,
    recursionWarnThreshold: options.recursionWarnThreshold,
  };

  // No workspace, or a workspace with no wiki of its own, means there's
  // nothing a wiki_mismatch anomaly could be checked against.
  const expectedWikiId = task.workspaceId
    ? (stores.workspaceStore.getWorkspace(task.workspaceId)?.wikiId ?? null)
    : null;

  const anomalies: Anomaly[] = [];

  const runs: TaskRunRetrospective[] = stores.workspaceStore.listTaskRuns(taskId).map((run) => {
    const threadReport = run.threadId
      ? buildThreadReport(run.threadId, stores, reportOptions)
      : null;
    if (threadReport) {
      anomalies.push(...findWikiMismatches(threadReport, expectedWikiId));
      anomalies.push(...findRecursionEscalations(threadReport, taskId));
    }
    return {
      runId: run.id,
      runNumber: run.runNumber,
      status: run.status,
      summary: run.summary,
      recoveryAttempts: run.recoveryAttempts,
      threadReport,
    };
  });

  const streak = stores.workspaceStore.failedRunStreaks([taskId]).get(taskId);
  if (streak) {
    anomalies.push({
      kind: 'repeated_failures',
      taskId,
      taskTitle: task.title,
      attempts: streak.attempts,
      lastSummary: streak.lastSummary,
    });
  }

  anomalies.sort((a, b) => anomalySortKey(a).localeCompare(anomalySortKey(b)));

  const handoffEntry = stores.workspaceStore.handedOffRunCounts([taskId]).get(taskId);
  const handoff: HandoffSummary | null = handoffEntry
    ? {
        taskId,
        taskTitle: task.title,
        count: handoffEntry.count,
        lastSummary: handoffEntry.lastSummary,
      }
    : null;

  const progressEntries = stores.workspaceStore.listTaskProgressEntriesForTask(taskId);

  let failureCount = 0;
  let wikiWriteCount = 0;
  for (const run of runs) {
    failureCount += run.threadReport?.stats.failureCount ?? 0;
    wikiWriteCount += run.threadReport?.stats.wikiWriteCount ?? 0;
  }

  return {
    taskId,
    generatedAt: new Date().toISOString(),
    task,
    runs,
    anomalies,
    handoff,
    progressEntries,
    summary: {
      runCount: runs.length,
      failureCount,
      wikiWriteCount,
      anomalyCount: anomalies.length,
    },
    runsToComplete: task.status === 'done' ? runs.length : null,
  };
}
