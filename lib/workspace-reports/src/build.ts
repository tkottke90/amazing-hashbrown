import { buildThreadReport } from '@tkottke90/thread-reports';
import type { ThreadReportData, HitlPromptPayload } from '@tkottke90/thread-reports';
import { buildTaskRunReport } from '@tkottke90/task-run-reports';
import type {
  WorkspaceRetrospectiveData,
  WorkspaceReportStores,
  Anomaly,
  HandoffSummary,
  TaskRetrospective,
} from './types.js';

export interface BuildWorkspaceRetrospectiveOptions {
  recursionLimit?: number;
  recursionWarnThreshold?: number;
}

// The two HITL prompt kinds recursion-guard.middleware.ts raises when a run
// gets a check-in interrupt — see api/src/agents/recursion-guard.middleware.ts.
// Duplicated from @tkottke90/task-run-reports' build.ts (which runs the same
// check per task run) rather than imported — that package doesn't export
// these helpers, only buildTaskRunReport itself, and this copy is only ever
// applied to the one thread (the workspace's own chat) that isn't part of
// any task's run history, so buildTaskRunReport can't cover it.
const RECURSION_ESCALATION_KINDS = new Set(['recursion_limit_warning', 'loop_stagnation_warning']);

function findRecursionEscalations(report: ThreadReportData, taskId: string | null): Anomaly[] {
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
// enough to flag a write that landed outside the workspace's own wiki.
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

// Composes @tkottke90/task-run-reports' buildTaskRunReport per task (and
// @tkottke90/thread-reports' buildThreadReport directly for the workspace's
// own chat thread, which isn't part of any task) rather than re-deriving
// per-task anomaly/handoff/progress-entry aggregation here — see AGENTS.md's
// "Composition over Customization" principle. Returns null only when the
// workspace itself doesn't exist; a missing/empty chat thread or task list
// still produces a (mostly empty) report.
export function buildWorkspaceRetrospective(
  workspaceId: string,
  stores: WorkspaceReportStores,
  options: BuildWorkspaceRetrospectiveOptions = {},
): WorkspaceRetrospectiveData | null {
  const workspace = stores.workspaceStore.getWorkspace(workspaceId);
  if (!workspace) return null;

  const reportOptions = {
    recursionLimit: options.recursionLimit,
    recursionWarnThreshold: options.recursionWarnThreshold,
  };

  const chat = workspace.threadId
    ? buildThreadReport(workspace.threadId, stores, reportOptions)
    : null;

  const anomalies: Anomaly[] = [];
  if (chat) {
    anomalies.push(...findWikiMismatches(chat, workspace.wikiId));
    anomalies.push(...findRecursionEscalations(chat, null));
  }

  const tasksRaw = stores.workspaceStore.listTasks({ workspaceId });
  const handoffs: HandoffSummary[] = [];

  const tasks: TaskRetrospective[] = tasksRaw.map((task) => {
    // Only returns null if the task itself doesn't exist, which can't
    // happen here — task was just read from listTasks() above.
    const taskReport = buildTaskRunReport(task.id, stores, reportOptions);
    if (!taskReport) {
      return {
        taskId: task.id,
        title: task.title,
        status: task.status,
        origin: task.origin,
        provider: task.provider,
        model: task.model,
        runs: [],
        progressEntries: [],
        runsToComplete: null,
      };
    }

    anomalies.push(...taskReport.anomalies);
    if (taskReport.handoff) handoffs.push(taskReport.handoff);

    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      origin: task.origin,
      provider: task.provider,
      model: task.model,
      runs: taskReport.runs,
      progressEntries: taskReport.progressEntries,
      runsToComplete: taskReport.runsToComplete,
    };
  });

  anomalies.sort((a, b) => anomalySortKey(a).localeCompare(anomalySortKey(b)));

  let runCount = 0;
  let failureCount = chat?.stats.failureCount ?? 0;
  let wikiWriteCount = chat?.stats.wikiWriteCount ?? 0;
  for (const task of tasks) {
    runCount += task.runs.length;
    for (const run of task.runs) {
      failureCount += run.threadReport?.stats.failureCount ?? 0;
      wikiWriteCount += run.threadReport?.stats.wikiWriteCount ?? 0;
    }
  }

  const handoffCount = handoffs.reduce((n, h) => n + h.count, 0);

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    workspace,
    chat,
    tasks,
    anomalies,
    handoffs,
    summary: {
      taskCount: tasks.length,
      runCount,
      failureCount,
      wikiWriteCount,
      anomalyCount: anomalies.length,
      handoffCount,
    },
    narrative: null,
  };
}
