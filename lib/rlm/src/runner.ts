import type {
  ModelAdapter,
  RlmEmbeddingAdapter,
  RLMConfig,
  RLMCorpus,
  RLMResult,
  RLMLogger,
  StatusCallback,
  Tool,
  ToolCallRecord,
  Message,
  IterationPhase,
  CorpusMeta,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { REPLEnvironment, SENTINEL_FINAL, SENTINEL_NOT_FOUND } from './repl.js';
import { buildRootSystemPrompt } from './prompts.js';
import { TraceBuilder, deriveSourcesUsed, deriveMetrics } from './trace.js';

const CORE_TOOLS: Tool[] = [
  {
    name: 'peek',
    description:
      'Read the first N characters of the document. Use this first to understand structure and vocabulary.',
    parameters: {
      type: 'object',
      properties: {
        chars: {
          type: 'number',
          description: 'Number of characters to read (default 2000)',
        },
      },
      required: [],
    },
  },
  {
    name: 'grep',
    description:
      'Search the document for a regex pattern. Returns matching lines with their line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results (default 50)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'slice',
    description:
      'Read a specific line range from the document. Hard limit applies — use summarize for large ranges.',
    parameters: {
      type: 'object',
      properties: {
        startLine: { type: 'number', description: 'First line to read (1-indexed)' },
        endLine: { type: 'number', description: 'Last line to read (inclusive)' },
      },
      required: ['startLine', 'endLine'],
    },
  },
  {
    name: 'summarize',
    description:
      'Distill a section that is too large to slice. The summary is scoped to the given range only — a NOT FOUND result means absent from that range, not from the full document.',
    parameters: {
      type: 'object',
      properties: {
        startLine: { type: 'number', description: 'First line of the range' },
        endLine: { type: 'number', description: 'Last line of the range' },
        focus: {
          type: 'string',
          description: 'Optional topic or question to focus the summary on',
        },
      },
      required: ['startLine', 'endLine'],
    },
  },
  {
    name: 'query',
    description:
      'Ask a specific question about a line range. Returns NOT FOUND IN THIS RANGE if the answer is absent from that range.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to answer' },
        startLine: { type: 'number', description: 'First line of the range' },
        endLine: { type: 'number', description: 'Last line of the range' },
      },
      required: ['question', 'startLine', 'endLine'],
    },
  },
  {
    name: 'not_found',
    description:
      'Call this when you have exhausted your search and the answer is not in the document. Describe what you searched for.',
    parameters: {
      type: 'object',
      properties: {
        searched: {
          type: 'string',
          description: 'Description of what was searched',
        },
      },
      required: ['searched'],
    },
  },
  {
    name: 'final_answer',
    description: 'Call this when you have found the answer. Provide your complete response.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Your complete answer' },
      },
      required: ['content'],
    },
  },
];

const SEARCH_TOOL: Tool = {
  name: 'search',
  description:
    'Semantic search by meaning — finds passages even when wording differs from the query. Returns candidate regions with line numbers. Always read (slice) a result before answering from it.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Plain-language description of what the passage would say, not the question's exact wording",
      },
      topK: {
        type: 'number',
        description: 'Number of results to return (default 5)',
      },
    },
    required: ['query'],
  },
};

const PROVENANCE_TOOL: Tool = {
  name: 'get_provenance',
  description:
    'Look up the original source of a fact: which document it came from, its type, when it was written, and how old it is.',
  parameters: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description: 'The fact or claim to look up (as close to verbatim as possible)',
      },
    },
    required: ['fact'],
  },
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
  private readonly adapter: ModelAdapter;
  private readonly embeddingAdapter: RlmEmbeddingAdapter | null;
  private readonly config: RLMConfig;
  private readonly logger: RLMLogger | undefined;

  constructor(
    adapter: ModelAdapter,
    embeddingAdapter?: RlmEmbeddingAdapter,
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
      const response = await this.adapter.complete(history, tools, this.config);
      tb.modelResponded(modelCorrId, iteration, response, Date.now() - modelStart);

      // Plain text response (no tool calls) — treat as final answer
      if (response.toolCalls.length === 0) {
        answer = response.content;
        terminationReason = 'no_tool_call';
        break;
      }

      const toolCall = response.toolCalls[0]!;

      // Loop detection: same tool + same args as previous call
      const prevSig = recentCalls.at(-1);
      if (
        prevSig &&
        prevSig.tool === toolCall.name &&
        prevSig.args === JSON.stringify(toolCall.args)
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

      recentCalls.push({ tool: toolCall.name, args: JSON.stringify(toolCall.args) });
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
        args: toolCall.args,
        resultPreview: result.slice(0, 200),
        durationMs: toolDuration,
      });

      history.push({
        role: 'assistant',
        content: response.content,
        toolCalls: [toolCall],
      });
      history.push({
        role: 'tool',
        content: result,
        toolName: toolCall.name,
      });
    }

    // Max iterations failsafe
    if (terminationReason === 'max_iterations') {
      const synthCorrId = tb.synthesisTriggered();
      const synthStart = Date.now();
      const { text, hadToolCallEscape } = await this._synthesize(history, tools);
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

  private _buildToolList(repl: REPLEnvironment): Tool[] {
    const list = [...CORE_TOOLS];
    if (repl.hasIndex()) list.push(SEARCH_TOOL);
    if (repl.hasProvenance()) list.push(PROVENANCE_TOOL);
    if (this.config.extraTools) list.push(...this.config.extraTools);
    return list;
  }

  private async _synthesize(
    history: Message[],
    _tools: Tool[],
  ): Promise<{ text: string; hadToolCallEscape: boolean }> {
    const synthesis: Message[] = [
      ...history,
      {
        role: 'user',
        content:
          'You have reached the maximum number of steps. Synthesize your best answer from what you have gathered so far. Respond with plain text only — no tool calls.',
      },
    ];

    const response = await this.adapter.complete(synthesis, [], this.config);

    if (response.toolCalls.length > 0 || looksLikeToolCall(response.content)) {
      const retry = await this.adapter.complete(
        [
          ...synthesis,
          {
            role: 'user',
            content:
              'Plain text only. Do not call any tools. Write your answer as a single paragraph.',
          },
        ],
        [],
        this.config,
      );
      const text = retry.content.trim() || '[synthesis failed]';
      return { text, hadToolCallEscape: true };
    }

    return { text: response.content.trim() || '[synthesis failed]', hadToolCallEscape: false };
  }
}

function looksLikeToolCall(text: string): boolean {
  const t = text.trim();
  return t.includes('<tool_call>') || (t.startsWith('[') && t.includes('"name"'));
}
