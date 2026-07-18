import type {
  ThreadReportData,
  ThreadReportStats,
  ThreadStoreLike,
  ObservabilityStoreLike,
  TimelineEvent,
  TraceOutcome,
  ToolCallPayload,
  WikiUpdatePayload,
} from './types.js';

const AFTER_AGENT_PREFIX = 'after-agent:';

function computeStats(
  messages: ThreadReportData['thread']['messages'],
  failureCount: number,
): ThreadReportStats {
  const turnCount = messages.filter((m) => m.kind === 'user').length;
  const toolCallMessages = messages.filter((m) => m.kind === 'tool_call');
  const toolCallCount = toolCallMessages.length;
  const wikiWriteCount = messages.filter((m) => m.kind === 'wiki_update').length;

  const toolCounts = new Map<string, number>();
  for (const m of toolCallMessages) {
    const { toolName } = m.payload as ToolCallPayload;
    toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
  }

  let mostPopularTool: string | null = null;
  let mostPopularCount = 0;
  for (const [name, count] of [...toolCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > mostPopularCount) {
      mostPopularTool = name;
      mostPopularCount = count;
    }
  }

  return { turnCount, toolCallCount, mostPopularTool, failureCount, wikiWriteCount };
}

function classifyAfterAgentOutcome(spanNames: Set<string>): TraceOutcome {
  const hasClassify = spanNames.has(`${AFTER_AGENT_PREFIX}classify`);
  const hasExtract = spanNames.has(`${AFTER_AGENT_PREFIX}extract`);
  if (!hasClassify) return 'unknown';
  return hasExtract ? 'identified' : 'no-op';
}

export function buildThreadReport(
  threadId: string,
  stores: { threadStore: ThreadStoreLike; observabilityStore: ObservabilityStoreLike },
): ThreadReportData | null {
  const thread = stores.threadStore.getThread(threadId, { showErrors: true });
  if (!thread) return null;

  const traceSummaries = stores.observabilityStore.find({ threadId, limit: 1000 });
  const traces = traceSummaries
    .map((s) => stores.observabilityStore.getTrace(s.traceId))
    .filter((t) => t !== null);

  let failureCount = 0;
  const timeline: TimelineEvent[] = [];

  for (const trace of traces) {
    const spanNames = new Set(trace.spans.map((s) => s.name));
    const isAfterAgent = [...spanNames].some((n) => n.startsWith(AFTER_AGENT_PREFIX));
    failureCount += trace.spans.filter((s) => s.error !== null).length;

    timeline.push(
      isAfterAgent
        ? {
            kind: 'trace',
            source: 'after-agent',
            trace,
            outcome: classifyAfterAgentOutcome(spanNames),
          }
        : { kind: 'trace', source: 'main-turn', trace },
    );
  }

  for (const m of thread.messages) {
    if (m.kind !== 'wiki_update') continue;
    const payload = m.payload as WikiUpdatePayload;
    timeline.push({
      kind: 'wiki_update',
      seq: m.seq,
      pageTitle: payload.pageTitle,
      pageKind: payload.pageKind,
      wikiName: payload.wikiName,
      at: m.createdAt,
    });
  }

  timeline.sort((a, b) => {
    const aTime = a.kind === 'trace' ? a.trace.startedAt : a.at;
    const bTime = b.kind === 'trace' ? b.trace.startedAt : b.at;
    return aTime.localeCompare(bTime);
  });

  return {
    threadId,
    generatedAt: new Date().toISOString(),
    thread,
    stats: computeStats(thread.messages, failureCount),
    timeline,
  };
}
