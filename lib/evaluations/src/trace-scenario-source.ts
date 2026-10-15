import { stringify } from 'yaml';
import type { TraceWithSpans, SpanRecord, TraceSource } from '@tkottke90/llm-common-types/traces';
import { ScenarioSchema, type Scenario } from './schemas.js';

// A thread message, reduced to the three fields this module needs — any
// object with these fields works (notably api/'s ThreadMessageRecord, which
// is a structural superset), so this module stays decoupled from the api/
// workspace's internal thread-store types.
export interface ScenarioSourceMessage {
  kind: string;
  seq: number;
  payload: unknown;
}

export interface ScenarioUserTurnSeed {
  user: string;
}

export interface ScenarioToolTurnSeed {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export type ScenarioTurnSeed = ScenarioUserTurnSeed | ScenarioToolTurnSeed;

export interface ScenarioSource {
  traceId: string;
  threadId: string | null;
  source: TraceSource;
  provider: string;
  model: string;
  error: string | null;
  // Seeded conversation history, in the same {user} / {tool,args,result}
  // shape ScenarioSchema's turns/ToolTurnSchema expect — everything the
  // trace's model decided up to (but not including) its final decision.
  turns: ScenarioTurnSeed[];
  // The trace's final decision, for a human to review when filling in the
  // scenario's TODO fields (expected tool/rubric) — not seeded data.
  finalToolCall: { name: string; args: unknown } | null;
  finalAssistantText: string | null;
  // False only when every turn was reconstructed from the thread's full,
  // untruncated messages. True means at least one turn fell back to the
  // trace's own (possibly truncated, possibly absent) span data.
  incomplete: boolean;
  incompleteReason?: string;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parsePreview(text: string | null | undefined): unknown {
  if (text == null) return {};
  return tryParseJson(text);
}

// ToolTurnSchema requires args/result to be plain objects — a tool whose
// actual output is a string or array (e.g. a search-results list) gets
// wrapped so the draft still validates; a human reviewing the scaffold will
// see the real content either way.
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

// The last llm-call span's outputPreview is either a JSON array of the tool
// calls the model decided to make, or its final reply text (see
// observability-handler.ts's handleLLMEnd) — never seeded as a turn, since
// it's the thing a scenario built from this trace would assert against.
function extractFinalDecision(spans: SpanRecord[]): {
  finalToolCall: { name: string; args: unknown } | null;
  finalAssistantText: string | null;
} {
  const lastLlmCall = spans.filter((s) => s.type === 'llm-call').at(-1);
  if (!lastLlmCall?.outputPreview) {
    return { finalToolCall: null, finalAssistantText: null };
  }
  const parsed = tryParseJson(lastLlmCall.outputPreview);
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.name === 'string') {
    const call = parsed[0] as { name: string; args?: unknown };
    return { finalToolCall: { name: call.name, args: call.args ?? {} }, finalAssistantText: null };
  }
  return { finalToolCall: null, finalAssistantText: lastLlmCall.outputPreview };
}

// Trace tool-call spans and thread tool_call messages use different ID
// spaces (LangChain's own runId vs. LangGraph's tool_call.id) — correlate by
// tool name within chronological order instead. fromIndex advances past
// each match so a repeated tool name pairs calls in the order they happened.
function findMatchingToolCallMessage(
  messages: ScenarioSourceMessage[],
  fromIndex: number,
  toolName: string,
): { message: ScenarioSourceMessage; index: number } | null {
  for (let i = fromIndex; i < messages.length; i++) {
    const payload = messages[i]!.payload as { toolName?: string };
    if (payload.toolName === toolName) return { message: messages[i]!, index: i };
  }
  return null;
}

function findOpeningUserMessage(
  userMessages: ScenarioSourceMessage[],
  traceStartedAt: string,
): ScenarioSourceMessage | undefined {
  const startedAtMs = new Date(traceStartedAt).getTime();
  const preceding = userMessages.filter((m) => {
    const sentAt = (m.payload as { sentAt?: string }).sentAt;
    return sentAt !== undefined && new Date(sentAt).getTime() <= startedAtMs;
  });
  return preceding.at(-1) ?? userMessages[0];
}

/**
 * Joins a trace's spans (for ordering/structure) with its linked thread's
 * full message history (for untruncated content) into scenario-authoring-
 * ready data. `messages` should be the thread's complete, uncapped message
 * list (or [] when the trace has no linked thread) — see
 * ThreadStore.getThreadMessages, which defaults to a 200-message display
 * cap that must be overridden by the caller for this use.
 */
export function buildScenarioSource(
  trace: TraceWithSpans,
  messages: ScenarioSourceMessage[],
): ScenarioSource {
  const { finalToolCall, finalAssistantText } = extractFinalDecision(trace.spans);

  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const toolCallMessages = ordered.filter((m) => m.kind === 'tool_call');
  const userMessages = ordered.filter((m) => m.kind === 'user');

  const incompleteReasons: string[] = [];
  const turns: ScenarioTurnSeed[] = [];

  const openingUser =
    userMessages.length > 0 ? findOpeningUserMessage(userMessages, trace.startedAt) : undefined;
  if (openingUser) {
    turns.push({ user: (openingUser.payload as { content?: string }).content ?? '' });
  } else {
    turns.push({ user: 'TODO - no user message found for this trace' });
    incompleteReasons.push('no user message found to seed the opening turn');
  }

  let cursor = 0;
  for (const span of trace.spans.filter((s) => s.type === 'tool-call')) {
    const match = findMatchingToolCallMessage(toolCallMessages, cursor, span.name);
    if (!match) {
      turns.push({
        tool: span.name,
        args: asRecord(parsePreview(span.inputPreview)),
        result: asRecord(parsePreview(span.outputPreview)),
      });
      incompleteReasons.push(
        `no matching thread message found for tool call "${span.name}" — used the trace's truncated preview`,
      );
      continue;
    }

    cursor = match.index + 1;
    const payload = match.message.payload as {
      toolName: string;
      inputs: unknown;
      outputs?: unknown;
    };
    if (payload.outputs !== undefined) {
      turns.push({
        tool: payload.toolName,
        args: asRecord(payload.inputs),
        result: asRecord(payload.outputs),
      });
    } else {
      turns.push({
        tool: payload.toolName,
        args: asRecord(payload.inputs),
        result: asRecord(span.error ?? parsePreview(span.outputPreview)),
      });
      incompleteReasons.push(
        `tool call "${span.name}" has no recorded result in the thread (${
          span.error ? 'errored' : 'still pending'
        }) — used the trace's preview/error instead`,
      );
    }
  }

  return {
    traceId: trace.traceId,
    threadId: trace.threadId,
    source: trace.source,
    provider: trace.provider,
    model: trace.model,
    error: trace.error,
    turns,
    finalToolCall,
    finalAssistantText,
    incomplete: incompleteReasons.length > 0,
    incompleteReason: incompleteReasons.length > 0 ? incompleteReasons.join('; ') : undefined,
  };
}

export interface ScenarioDraftOptions {
  id?: string;
}

/**
 * Builds a complete-enough-to-validate scenario draft from a ScenarioSource:
 * `tool-sequence` when the trace made any tool calls, `llm-judge` otherwise.
 * The seeded conversation (`turns`/`input`) is real, captured content; the
 * fields that require human judgment about correct behavior (`tool`,
 * `rubric`) stay as TODO placeholders. Throws if the result doesn't satisfy
 * ScenarioSchema — fails loudly on a malformed draft rather than writing
 * invalid YAML into a suite file.
 */
export function buildScenarioDraft(
  source: ScenarioSource,
  opts: ScenarioDraftOptions = {},
): Scenario {
  const id = opts.id ?? 'TODO-change-me';
  const noteSuffix = source.incomplete ? ` NOTE: incomplete — ${source.incompleteReason}.` : '';
  const purpose = `Regression: captured from trace ${source.traceId}.${noteSuffix}`;
  const hasToolTurns = source.turns.some((t) => 'tool' in t);

  if (!hasToolTurns) {
    const opening = source.turns[0];
    const input = opening && 'user' in opening ? opening.user : 'TODO - extract from trace';
    return ScenarioSchema.parse({
      id,
      name: 'TODO - scenario name',
      purpose,
      type: 'llm-judge',
      input,
      rubric: 'TODO - what should the correct response look like?',
      minScore: 7,
    });
  }

  return ScenarioSchema.parse({
    id,
    name: 'TODO - scenario name',
    purpose,
    type: 'tool-sequence',
    turns: source.turns,
    tool: source.finalToolCall?.name ?? 'TODO-change-me',
    minScore: 1,
  });
}

/** Formats a validated scenario as a 2-space-indented YAML list item, ready
 * to append under a suite file's existing top-level `scenarios:` key. */
export function formatSuiteYamlBlock(scenario: Scenario): string {
  const yamlText = stringify([scenario], { indent: 2 });
  const indented = yamlText
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
  return `\n${indented}`;
}
