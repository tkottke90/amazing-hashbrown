import { z } from 'zod';
import type {
  InferenceAdapter,
  EmbeddingAdapter,
  ToolDefinition,
  Message,
  RLMConfig,
  RLMCorpus,
  RLMResult,
  RLMLogger,
  StatusCallback,
  ToolCallRecord,
  IterationPhase,
  CorpusMeta,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { REPLEnvironment, SENTINEL_FINAL, SENTINEL_NOT_FOUND } from './repl.js';
import { buildRootSystemPrompt } from './prompts.js';
import { TraceBuilder, deriveSourcesUsed, deriveMetrics } from './trace.js';

const CORE_TOOLS: ToolDefinition[] = [
  {
    name: 'peek',
    description:
      'Read the first N characters of the document. Use this first to understand structure and vocabulary.',
    parameters: z.object({
      chars: z.number().optional().describe('Number of characters to read (default 2000)'),
    }),
  },
  {
    name: 'grep',
    description:
      'Search the document for a regex pattern. Returns matching lines with their line numbers.',
    parameters: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      maxResults: z.number().optional().describe('Maximum number of results (default 50)'),
    }),
  },
  {
    name: 'slice',
    description:
      'Read a specific line range from the document. Hard limit applies — use summarize for large ranges.',
    parameters: z.object({
      startLine: z.number().describe('First line to read (1-indexed)'),
      endLine: z.number().describe('Last line to read (inclusive)'),
    }),
  },
  {
    name: 'summarize',
    description:
      'Distill a section that is too large to slice. The summary is scoped to the given range only — a NOT FOUND result means absent from that range, not from the full document.',
    parameters: z.object({
      startLine: z.number().describe('First line of the range'),
      endLine: z.number().describe('Last line of the range'),
      focus: z.string().optional().describe('Optional topic or question to focus the summary on'),
    }),
  },
  {
    name: 'query',
    description:
      'Ask a specific question about a line range. Returns NOT FOUND IN THIS RANGE if the answer is absent from that range.',
    parameters: z.object({
      question: z.string().describe('The question to answer'),
      startLine: z.number().describe('First line of the range'),
      endLine: z.number().describe('Last line of the range'),
    }),
  },
  {
    name: 'not_found',
    description:
      'Call this when you have exhausted your search and the answer is not in the document. Describe what you searched for.',
    parameters: z.object({
      searched: z.string().describe('Description of what was searched'),
    }),
  },
  {
    name: 'final_answer',
    description: 'Call this when you have found the answer. Provide your complete response.',
    parameters: z.object({
      content: z.string().describe('Your complete answer'),
    }),
  },
];

const SEARCH_TOOL: ToolDefinition = {
  name: 'search',
  description:
    'Semantic search by meaning — finds passages even when wording differs from the query. Returns candidate regions with line numbers. Always read (slice) a result before answering from it.',
  parameters: z.object({
    query: z
      .string()
      .describe(
        "Plain-language description of what the passage would say, not the question's exact wording",
      ),
    topK: z.number().optional().describe('Number of results to return (default 5)'),
  }),
};

const PROVENANCE_TOOL: ToolDefinition = {
  name: 'get_provenance',
  description:
    'Look up the original source of a fact: which document it came from, its type, when it was written, and how old it is.',
  parameters: z.object({
    fact: z.string().describe('The fact or claim to look up (as close to verbatim as possible)'),
  }),
};

// Maps each tool name to its iteration phase label and user-facing status message.
// Both the trace and the StatusCallback derive from this single source.
const TOOL_DISPLAY: Record<string, { phase: IterationPhase; message: string }> = {
  peek: { phase: 'orientation', message: 'Checking your memory...' },
  grep: { phase: 'searching', message: 'Searching your memory...' },
  search: { phase: 'searching', message: 'Searching for relevant context...' },
  slice: { phase: 'reading', message: 'Reading relevant section...' },
  summarize: { phase: 'summarizing', message: 'Reviewing a longer section...' },
  query: { phase: 'querying', message: 'Checking a specific part of your memory...' },
  get_provenance: { phase: 'reading', message: 'Looking up the source of that...' },
  final_answer: { phase: 'answering', message: '' },
  not_found: { phase: 'not_found', message: '' },
};

export class RLMRunner {
  private readonly adapter: InferenceAdapter;
  private readonly embeddingAdapter: EmbeddingAdapter | null;
  private readonly config: RLMConfig;
  private readonly logger: RLMLogger | undefined;

  constructor(
    adapter: InferenceAdapter,
    embeddingAdapter?: EmbeddingAdapter,
    config?: Partial<RLMConfig>,
    logger?: RLMLogger,
  ) {
    this.adapter = adapter;
    this.embeddingAdapter = embeddingAdapter ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  async run(query: string, corpus: RLMCorpus, onStatus?: StatusCallback): Promise<RLMResult> {
    const startMs = Date.now();
    const detail = this.config.traceDetail ?? 'full';
    const tb = new TraceBuilder(detail, this.logger);

    const repl = new REPLEnvironment(corpus, this.config, this.adapter);
    if (this.embeddingAdapter) await repl.buildIndex(this.embeddingAdapter);

    const corpusMeta: CorpusMeta = {
      source: corpus.source,
      charCount: repl.charCount,
      lineCount: repl.lineCount,
      hasEmbeddings: repl.hasIndex(),
      hasProvenance: repl.hasProvenance(),
    };

    const tools = this._buildToolList(repl);
    const systemPrompt = buildRootSystemPrompt(
      repl.charCount,
      repl.lineCount,
      repl.source,
      this.config,
    );

    tb.runStarted(query, corpusMeta);

    const history: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ];

    const toolCallTrace: ToolCallRecord[] = [];
    let loopDetectionFired = false;
    let terminationReason: RLMResult['terminationReason'] = 'max_iterations';
    let answer = '';
    let found = true;

    const recentCalls: Array<{ tool: string; args: string }> = [];
    let remainingIterations = this.config.maxIterations;
    let iteration = 0;

    while (remainingIterations > 0) {
      remainingIterations--;
      iteration++;

      tb.iterationStarted(iteration);

      const modelCorrId = tb.modelRequested(iteration, history);
      const modelStart = Date.now();
      const response = await this.adapter.invoke(history, { tools });
      tb.modelResponded(modelCorrId, iteration, response, Date.now() - modelStart);

      // Plain text response (no tool calls) — treat as final answer
      if ((response.toolCalls ?? []).length === 0) {
        answer = response.message.content;
        terminationReason = 'no_tool_call';
        break;
      }

      const toolCall = response.toolCalls![0]!;

      // Loop detection: same tool + same args as previous call
      const prevSig = recentCalls.at(-1);
      if (
        prevSig &&
        prevSig.tool === toolCall.name &&
        prevSig.args === JSON.stringify(toolCall.arguments)
      ) {
        loopDetectionFired = true;
        const deducted = Math.min(2, remainingIterations);
        remainingIterations = Math.max(0, remainingIterations - 2);
        tb.loopDetection(iteration, toolCall, deducted);
        history.push({
          role: 'user',
          content: `You just called ${toolCall.name} with the same arguments again. Try a different approach — use a different tool, change your search terms, or call final_answer or not_found if you have exhausted your options.`,
        });
        continue;
      }

      recentCalls.push({ tool: toolCall.name, args: JSON.stringify(toolCall.arguments) });
      if (recentCalls.length > 3) recentCalls.shift();

      // Emit tool dispatched event and StatusCallback signal — both derived
      // from the same TOOL_DISPLAY entry to keep them consistent.
      const display = TOOL_DISPLAY[toolCall.name] ?? {
        phase: 'reading' as IterationPhase,
        message: '',
      };
      const toolCorrId = tb.toolDispatched(iteration, toolCall, display.phase, display.message);

      if (display.message && onStatus) {
        onStatus({
          phase: display.phase,
          message: display.message,
          iteration,
          tool: toolCall.name,
        });
      }

      const toolStart = Date.now();
      const result = await repl.execute(toolCall);
      const toolDuration = Date.now() - toolStart;

      // Check terminal sentinels before recording — final_answer and not_found
      // are signaling tools, not retrieval calls, so they're excluded from the trace.
      if (result === SENTINEL_NOT_FOUND) {
        tb.toolCompleted(toolCorrId, iteration, toolCall.name, result, toolDuration);
        found = false;
        terminationReason = 'not_found_tool';
        break;
      }

      if (result.startsWith(SENTINEL_FINAL)) {
        tb.toolCompleted(toolCorrId, iteration, toolCall.name, result, toolDuration);
        answer = result.slice(SENTINEL_FINAL.length);
        terminationReason = 'final_tool';
        break;
      }

      tb.toolCompleted(toolCorrId, iteration, toolCall.name, result, toolDuration);

      toolCallTrace.push({
        iteration,
        tool: toolCall.name,
        args: toolCall.arguments,
        resultPreview: result.slice(0, 200),
        durationMs: toolDuration,
      });

      history.push({
        role: 'assistant',
        content: response.message.content,
        toolCalls: [toolCall],
      });
      history.push({
        role: 'tool',
        results: [{ id: toolCall.id, content: result }],
      });
    }

    // Max iterations failsafe
    if (terminationReason === 'max_iterations') {
      const synthCorrId = tb.synthesisTriggered();
      const synthStart = Date.now();
      const { text, hadToolCallEscape } = await this._synthesize(history);
      tb.synthesisCompleted(synthCorrId, text, hadToolCallEscape, Date.now() - synthStart);
      answer = text;
    }

    const totalDurationMs = Date.now() - startMs;

    tb.runCompleted(terminationReason, found, iteration, totalDurationMs);

    const events = tb.getEvents();
    const metrics = deriveMetrics(events, corpusMeta);
    const sourcesUsed = deriveSourcesUsed(events);

    const result: RLMResult = {
      answer,
      found,
      iterations: iteration,
      toolCallTrace,
      terminationReason,
      loopDetectionFired,
      totalDurationMs,
      events,
      metrics,
      sourcesUsed,
    };

    const trace = tb.buildTrace(query, corpusMeta, this.config, systemPrompt, result, startMs);
    this.logger?.onTrace?.(trace);

    return result;
  }

  private _buildToolList(repl: REPLEnvironment): ToolDefinition[] {
    const list = [...CORE_TOOLS];
    if (repl.hasIndex()) list.push(SEARCH_TOOL);
    if (repl.hasProvenance()) list.push(PROVENANCE_TOOL);
    if (this.config.extraTools) list.push(...this.config.extraTools);
    return list;
  }

  private async _synthesize(
    history: Message[],
  ): Promise<{ text: string; hadToolCallEscape: boolean }> {
    const synthesis: Message[] = [
      ...history,
      {
        role: 'user',
        content:
          'You have reached the maximum number of steps. Synthesize your best answer from what you have gathered so far. Respond with plain text only — no tool calls.',
      },
    ];

    const response = await this.adapter.invoke(synthesis);

    if ((response.toolCalls?.length ?? 0) > 0 || looksLikeToolCall(response.message.content)) {
      const retry = await this.adapter.invoke([
        ...synthesis,
        {
          role: 'user',
          content:
            'Plain text only. Do not call any tools. Write your answer as a single paragraph.',
        },
      ]);
      const text = retry.message.content.trim() || '[synthesis failed]';
      return { text, hadToolCallEscape: true };
    }

    return {
      text: response.message.content.trim() || '[synthesis failed]',
      hadToolCallEscape: false,
    };
  }
}

function looksLikeToolCall(text: string): boolean {
  const t = text.trim();
  return t.includes('<tool_call>') || (t.startsWith('[') && t.includes('"name"'));
}
