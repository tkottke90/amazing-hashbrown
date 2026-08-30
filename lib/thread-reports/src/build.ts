import type { TraceWithSpans } from '@tkottke90/observability';
import { estimateTokens } from '@tkottke90/llm-common-types/tokens';
import type {
  ThreadReportData,
  ThreadReportStats,
  ThreadReportMessageRecord,
  ThreadStoreLike,
  ObservabilityStoreLike,
  TimelineEvent,
  TraceOutcome,
  ToolCallPayload,
  WikiUpdatePayload,
  UserPayload,
  AssistantPayload,
  SummaryPayload,
  ContextWindowSnapshot,
} from './types.js';

const AFTER_AGENT_PREFIX = 'after-agent:';

const DEFAULT_RECURSION_LIMIT = 100;
const DEFAULT_RECURSION_WARN_THRESHOLD = 0.75;
const DEFAULT_CONTEXT_WINDOW_MAX_TOKENS = 32000;

export interface BuildThreadReportOptions {
  recursionLimit?: number;
  recursionWarnThreshold?: number;
  contextWindowMaxTokens?: number;
}

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

// Cumulative 1-based count of assistant messages, in seq order — the same
// count api/src/agents/recursion-guard.middleware.ts checks against
// env.agent.recursionLimit (state.messages.filter(isAIMessage).length). A
// retried assistant message (retryOf set) is its own record with its own
// id, so it gets its own step — correct, since a retry is a new AIMessage
// LangGraph appends to state.
function attachStepIndex(messages: ThreadReportMessageRecord[]): ThreadReportMessageRecord[] {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  let step = 0;
  const stepById = new Map<string, number>();
  for (const m of ordered) {
    if (m.kind === 'assistant') {
      step += 1;
      stepById.set(m.id, step);
    }
  }
  return messages.map((m) =>
    m.kind === 'assistant' ? { ...m, stepIndex: stepById.get(m.id) } : m,
  );
}

// Message kinds that were ever part of the LLM's actual message state, and
// therefore count toward context size. hitl_prompt/wiki_update/resource_card/
// task_run_marker are side-channel/UI records that were never sent to a
// model — an allow-list (not a deny-list) so a future new UI-marker kind
// can't silently leak into the token count.
const CONTEXT_WALK_KINDS = new Set(['user', 'assistant', 'tool_call', 'summary']);

function messageText(m: ThreadReportMessageRecord): string {
  switch (m.kind) {
    case 'user':
      return (m.payload as UserPayload).content ?? '';
    case 'assistant':
      // Never thoughtContent — that's UI-only reasoning display, not part of
      // the message content that would actually be sent back into context.
      return (m.payload as AssistantPayload).content ?? '';
    case 'summary':
      return (m.payload as SummaryPayload).content ?? '';
    case 'tool_call': {
      const p = m.payload as ToolCallPayload;
      // One record represents two real LangChain messages — an AIMessage's
      // tool_calls (inputs) plus a ToolMessage result (outputs) — both must
      // be estimated together.
      return `${JSON.stringify(p.inputs ?? null)}\n${JSON.stringify(p.outputs ?? null)}`;
    }
    default:
      return '';
  }
}

// Replays the same budget contextWindowMiddleware (api/src/agents/chat-agent.ts)
// applies live — keep the most recent messages within maxTokens, never
// starting the kept tail mid-tool-call-result pair — but at report-build
// time, over already-persisted ThreadReportMessageRecords rather than live
// BaseMessage state. Returns undefined when there are no countable messages,
// so the caller can omit contextWindow rather than showing zeros.
function computeContextWindowSnapshot(
  messages: ThreadReportMessageRecord[],
  maxTokens: number,
): ContextWindowSnapshot | undefined {
  const counted = messages
    .filter((m) => CONTEXT_WALK_KINDS.has(m.kind))
    .sort((a, b) => a.seq - b.seq);
  if (counted.length === 0) return undefined;

  const tokensById = new Map<string, number>();
  let totalContextTokens = 0;
  for (const m of counted) {
    const tokens = estimateTokens(messageText(m));
    tokensById.set(m.id, tokens);
    totalContextTokens += tokens;
  }

  // Newest -> oldest accumulation, stop before exceeding maxTokens. An exact
  // match at maxTokens is kept, not excluded (strictly-greater check).
  let running = 0;
  let cutoffIndex = counted.length; // exclusive lower bound into `counted`
  for (let i = counted.length - 1; i >= 0; i--) {
    const tokens = tokensById.get(counted[i]!.id)!;
    if (running + tokens > maxTokens) break;
    running += tokens;
    cutoffIndex = i;
  }

  // startOn:'human' mirror — advance the cutoff forward to the nearest
  // user-kind message at or after it, so a tool-call/result pair is never
  // split. If no user message exists in the tentative tail, keep nothing.
  while (cutoffIndex < counted.length && counted[cutoffIndex]!.kind !== 'user') {
    cutoffIndex++;
  }

  const kept = cutoffIndex < counted.length ? counted.slice(cutoffIndex) : [];
  const activeContextTokens = kept.reduce((sum, m) => sum + tokensById.get(m.id)!, 0);
  const boundaryMessageId = kept.length > 0 && kept[0]!.id !== counted[0]!.id ? kept[0]!.id : null;

  return {
    totalContextTokens,
    activeContextTokens,
    contextWindowMaxTokens: maxTokens,
    boundaryMessageId,
  };
}

// Attaches estimateTokens(trace.systemPrompt) to every 'trace' timeline
// event as a single final pass, rather than threading it through each
// timeline.push() call site above.
function attachSystemPromptTokens(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.map((event) => {
    if (event.kind !== 'trace') return event;
    return {
      ...event,
      systemPromptTokens:
        event.trace.systemPrompt !== null ? estimateTokens(event.trace.systemPrompt) : null,
    };
  });
}

function classifyAfterAgentOutcome(spanNames: Set<string>): TraceOutcome {
  const hasClassify = spanNames.has(`${AFTER_AGENT_PREFIX}classify`);
  const hasExtract = spanNames.has(`${AFTER_AGENT_PREFIX}extract`);
  if (!hasClassify) return 'unknown';
  return hasExtract ? 'identified' : 'no-op';
}

// trace.source is the authoritative signal (set explicitly by every caller
// of startTrace() — see @tkottke90/observability's migration 5). The
// span-name fallback only matters for rows written before that migration
// existed, which defaulted to source: 'chat' but may still carry real
// after-agent:*-prefixed spans.
function isAfterAgentTrace(trace: TraceWithSpans): boolean {
  if (trace.source === 'after-agent') return true;
  return trace.spans.some((s) => s.name.startsWith(AFTER_AGENT_PREFIX));
}

// recordUserMessage() always runs before startTrace() in every chat call
// path (send/HITL-resume/retry — see stream-handler.ts), so the last user
// message at or before a chat trace's startedAt is the message that
// triggered it. HITL-resume/retry traces don't insert a fresh user message,
// so this correctly falls back to the original triggering message for them
// too. `userMessages` must be sorted ascending by createdAt.
function findTriggeringUserMessage(
  userMessages: ThreadReportMessageRecord[],
  traceStartedAt: string,
): ThreadReportMessageRecord | undefined {
  let match: ThreadReportMessageRecord | undefined;
  for (const m of userMessages) {
    if (m.createdAt > traceStartedAt) break;
    match = m;
  }
  return match;
}

export function buildThreadReport(
  threadId: string,
  stores: { threadStore: ThreadStoreLike; observabilityStore: ObservabilityStoreLike },
  options: BuildThreadReportOptions = {},
): ThreadReportData | null {
  const recursionLimit = options.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
  const recursionWarnThreshold = options.recursionWarnThreshold ?? DEFAULT_RECURSION_WARN_THRESHOLD;
  const contextWindowMaxTokens =
    options.contextWindowMaxTokens ?? DEFAULT_CONTEXT_WINDOW_MAX_TOKENS;

  const thread = stores.threadStore.getThread(threadId, { showErrors: true });
  if (!thread) return null;

  const traceSummaries = stores.observabilityStore.find({ threadId, limit: 1000 });
  const traces = traceSummaries
    .map((s) => stores.observabilityStore.getTrace(s.traceId))
    .filter((t) => t !== null);

  const userMessages = thread.messages
    .filter((m) => m.kind === 'user')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  let failureCount = 0;
  const timeline: TimelineEvent[] = [];

  for (const trace of traces) {
    failureCount += trace.spans.filter((s) => s.error !== null).length;

    if (isAfterAgentTrace(trace)) {
      const spanNames = new Set(trace.spans.map((s) => s.name));
      timeline.push({
        kind: 'trace',
        trace,
        outcome: classifyAfterAgentOutcome(spanNames),
        systemPromptTokens: null,
      });
    } else if (trace.source === 'chat') {
      timeline.push({
        kind: 'trace',
        trace,
        userMessage: findTriggeringUserMessage(userMessages, trace.startedAt),
        systemPromptTokens: null,
      });
    } else {
      timeline.push({ kind: 'trace', trace, systemPromptTokens: null });
    }
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

  const messagesWithStepIndex = attachStepIndex(thread.messages);
  const contextWindow = computeContextWindowSnapshot(messagesWithStepIndex, contextWindowMaxTokens);

  return {
    threadId,
    generatedAt: new Date().toISOString(),
    thread: { ...thread, messages: messagesWithStepIndex },
    stats: computeStats(thread.messages, failureCount),
    timeline: attachSystemPromptTokens(timeline),
    recursion: { recursionLimit, recursionWarnThreshold },
    ...(contextWindow ? { contextWindow } : {}),
  };
}
