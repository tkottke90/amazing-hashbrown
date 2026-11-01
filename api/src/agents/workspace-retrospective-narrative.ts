import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { WorkspaceRetrospectiveData, Anomaly } from '@tkottke90/workspace-reports';
import { logger, serializeError } from '../config/logger.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';

// One-shot narrative pass over a workspace retrospective's deterministic
// evidence bundle — modeled on workspace-summarizer.ts's
// maybeSummarizeWorkspace: a plain model.invoke() (no agent/tool harness),
// wrapped so a model failure degrades to "no narrative" rather than ever
// failing the retrospective report itself, which already has everything it
// needs from the deterministic data alone.

const PROMPT_PREFIX =
  'You are reviewing what happened in an autonomous coding workspace: its chat, the tasks it ' +
  'ran, and anomalies a deterministic pass already flagged (repeated task failures, a wiki ' +
  "write that landed outside the workspace's own wiki, a run that hit the recursion/stagnation " +
  'check-in). The evidence also lists handoffs separately from the anomalies — a handoff is a ' +
  'run that ended cooperatively because the user asked it to stop mid-conversation, with real ' +
  'progress recorded; it is not a failure and should not be treated as one in either section. ' +
  'Using only the evidence below, write two short sections in markdown: ' +
  '"## Likely causes" (why each anomaly probably happened, in plain terms) and ' +
  '"## Opportunities to improve" (concrete, specific suggestions for the task plan, the system ' +
  'prompt, or the recursion/retry settings — not generic advice). Be direct and specific; if ' +
  'there is nothing noteworthy, say so briefly rather than padding. Do not restate these ' +
  'instructions or the raw evidence back verbatim.\n\nEvidence:\n';

const MAX_EVIDENCE_CHARS = 20000;

function summarizeAnomaly(anomaly: Anomaly): string {
  switch (anomaly.kind) {
    case 'repeated_failures':
      return (
        `repeated_failures: task "${anomaly.taskTitle}" failed ${anomaly.attempts} time(s) in a ` +
        `row before its last settled run${anomaly.lastSummary ? ` — last summary: "${anomaly.lastSummary}"` : ''}`
      );
    case 'wiki_mismatch':
      return (
        `wiki_mismatch: wrote "${anomaly.pageTitle}" (${anomaly.pageKind}) to wiki ` +
        `"${anomaly.actualWikiName}" instead of this workspace's own wiki ("${anomaly.expectedWikiId}") ` +
        `at ${anomaly.at}`
      );
    case 'recursion_escalation':
      return (
        `recursion_escalation: ${anomaly.escalationKind} at ${anomaly.at}` +
        `${anomaly.taskId ? ` (task ${anomaly.taskId})` : ' (workspace chat)'} — "${anomaly.question}"`
      );
  }
}

function buildEvidenceSummary(data: WorkspaceRetrospectiveData): string {
  const lines: string[] = [];
  lines.push(`Workspace: ${data.workspace.name}`);
  if (data.workspace.goal) lines.push(`Goal: ${data.workspace.goal}`);
  lines.push(
    `Chat: ${
      data.chat
        ? `${data.chat.stats.turnCount} turns, ${data.chat.stats.toolCallCount} tool calls, ` +
          `${data.chat.stats.failureCount} failures, ${data.chat.stats.wikiWriteCount} wiki writes`
        : 'no chat thread'
    }`,
  );

  lines.push(`Tasks (${data.tasks.length}):`);
  for (const task of data.tasks) {
    lines.push(
      `- "${task.title}" [${task.origin}] status=${task.status} model=${task.provider ?? '?'}/${task.model ?? '?'}`,
    );
    for (const run of task.runs) {
      lines.push(
        `    run #${run.runNumber}: status=${run.status}, crash-recovery attempts=${run.recoveryAttempts}` +
          `${run.summary ? `, summary="${run.summary}"` : ''}` +
          `${run.threadReport ? `, ${run.threadReport.stats.toolCallCount} tool calls, ${run.threadReport.stats.failureCount} failures` : ''}`,
      );
    }
  }

  lines.push(`Anomalies flagged (${data.anomalies.length}):`);
  for (const anomaly of data.anomalies) {
    lines.push(`- ${summarizeAnomaly(anomaly)}`);
  }

  lines.push(`Handoffs (${data.handoffs.length}, not failures):`);
  for (const handoff of data.handoffs) {
    lines.push(
      `- task "${handoff.taskTitle}" handed off ${handoff.count} time(s)` +
        `${handoff.lastSummary ? ` — last summary: "${handoff.lastSummary}"` : ''}`,
    );
  }

  const joined = lines.join('\n');
  return joined.length > MAX_EVIDENCE_CHARS
    ? `${joined.slice(0, MAX_EVIDENCE_CHARS)}\n…(truncated)`
    : joined;
}

export interface GenerateRetrospectiveNarrativeParams {
  data: WorkspaceRetrospectiveData;
  model: BaseChatModel;
  provider?: string;
  modelName?: string;
}

// Never throws — a narrative-generation failure degrades to a report with
// narrative: null rather than failing the whole retrospective request.
export async function generateRetrospectiveNarrative(
  params: GenerateRetrospectiveNarrativeParams,
): Promise<string | null> {
  const { data, model, provider, modelName } = params;

  try {
    const prompt = `${PROMPT_PREFIX}${buildEvidenceSummary(data)}`;
    const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
      provider,
      modelName,
    );
    const turnObs = startTurnObservability({
      threadId: data.chat?.threadId,
      provider: resolvedProvider,
      model: resolvedModel,
      source: 'workspace-retrospective',
      systemPrompt: prompt,
    });

    let content: string;
    let traceError: string | null = null;
    try {
      const response = await model.invoke(prompt, { callbacks: [turnObs.obsHandler] });
      content =
        typeof response.content === 'string' ? response.content : String(response.content ?? '');
    } catch (err) {
      traceError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await turnObs.end(traceError);
    }

    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    logger.error('workspace-retrospective-narrative: generation failed', {
      workspaceId: data.workspaceId,
      err: serializeError(err),
    });
    return null;
  }
}
