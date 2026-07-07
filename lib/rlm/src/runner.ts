import type {
  ModelAdapter,
  RlmEmbeddingAdapter,
  RLMConfig,
  RLMCorpus,
  RLMResult,
  StatusCallback,
  StatusSignal,
  Tool,
  ToolCall,
  ToolCallRecord,
  Message,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { REPLEnvironment, SENTINEL_FINAL, SENTINEL_NOT_FOUND } from "./repl.js";
import { buildRootSystemPrompt } from "./prompts.js";

const CORE_TOOLS: Tool[] = [
  {
    name: "peek",
    description:
      "Read the first N characters of the document. Use this first to understand structure and vocabulary.",
    parameters: {
      type: "object",
      properties: {
        chars: {
          type: "number",
          description: "Number of characters to read (default 2000)",
        },
      },
      required: [],
    },
  },
  {
    name: "grep",
    description:
      "Search the document for a regex pattern. Returns matching lines with their line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        maxResults: {
          type: "number",
          description: "Maximum number of results (default 50)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "slice",
    description:
      "Read a specific line range from the document. Hard limit applies — use summarize for large ranges.",
    parameters: {
      type: "object",
      properties: {
        startLine: { type: "number", description: "First line to read (1-indexed)" },
        endLine: { type: "number", description: "Last line to read (inclusive)" },
      },
      required: ["startLine", "endLine"],
    },
  },
  {
    name: "summarize",
    description:
      "Distill a section that is too large to slice. The summary is scoped to the given range only — a NOT FOUND result means absent from that range, not from the full document.",
    parameters: {
      type: "object",
      properties: {
        startLine: { type: "number", description: "First line of the range" },
        endLine: { type: "number", description: "Last line of the range" },
        focus: {
          type: "string",
          description: "Optional topic or question to focus the summary on",
        },
      },
      required: ["startLine", "endLine"],
    },
  },
  {
    name: "query",
    description:
      "Ask a specific question about a line range. Returns NOT FOUND IN THIS RANGE if the answer is absent from that range.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer" },
        startLine: { type: "number", description: "First line of the range" },
        endLine: { type: "number", description: "Last line of the range" },
      },
      required: ["question", "startLine", "endLine"],
    },
  },
  {
    name: "not_found",
    description:
      "Call this when you have exhausted your search and the answer is not in the document. Describe what you searched for.",
    parameters: {
      type: "object",
      properties: {
        searched: {
          type: "string",
          description: "Description of what was searched",
        },
      },
      required: ["searched"],
    },
  },
  {
    name: "final_answer",
    description:
      "Call this when you have found the answer. Provide your complete response.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Your complete answer" },
      },
      required: ["content"],
    },
  },
];

const SEARCH_TOOL: Tool = {
  name: "search",
  description:
    "Semantic search by meaning — finds passages even when wording differs from the query. Returns candidate regions with line numbers. Always read (slice) a result before answering from it.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Plain-language description of what the passage would say, not the question's exact wording",
      },
      topK: {
        type: "number",
        description: "Number of results to return (default 5)",
      },
    },
    required: ["query"],
  },
};

const PROVENANCE_TOOL: Tool = {
  name: "get_provenance",
  description:
    "Look up the original source of a fact: which document it came from, its type, when it was written, and how old it is.",
  parameters: {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: "The fact or claim to look up (as close to verbatim as possible)",
      },
    },
    required: ["fact"],
  },
};

const STATUS_MAP: Record<
  string,
  { phase: StatusSignal["phase"]; message: string }
> = {
  peek: { phase: "searching", message: "Checking your memory..." },
  grep: { phase: "searching", message: "Searching your memory..." },
  search: { phase: "searching", message: "Searching for relevant context..." },
  slice: { phase: "reading", message: "Reading relevant section..." },
  summarize: { phase: "summarizing", message: "Reviewing a longer section..." },
  query: {
    phase: "querying",
    message: "Checking a specific part of your memory...",
  },
  get_provenance: {
    phase: "reading",
    message: "Looking up the source of that...",
  },
};

export class RLMRunner {
  private readonly adapter: ModelAdapter;
  private readonly embeddingAdapter: RlmEmbeddingAdapter | null;
  private readonly config: RLMConfig;

  constructor(
    adapter: ModelAdapter,
    embeddingAdapter?: RlmEmbeddingAdapter,
    config?: Partial<RLMConfig>
  ) {
    this.adapter = adapter;
    this.embeddingAdapter = embeddingAdapter ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async run(
    query: string,
    corpus: RLMCorpus,
    onStatus?: StatusCallback
  ): Promise<RLMResult> {
    const startTime = Date.now();

    const repl = new REPLEnvironment(corpus, this.config, this.adapter);

    if (this.embeddingAdapter) {
      await repl.buildIndex(this.embeddingAdapter);
    }

    const tools = this._buildToolList(repl);
    const systemPrompt = buildRootSystemPrompt(
      repl.charCount,
      repl.lineCount,
      repl.source,
      this.config
    );

    const history: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: query },
    ];

    const trace: ToolCallRecord[] = [];
    let loopDetectionFired = false;
    let terminationReason: RLMResult["terminationReason"] = "max_iterations";
    let answer = "";
    let found = true;

    // Last 2 tool calls for loop detection
    const recentCalls: Array<{ tool: string; args: string }> = [];
    let remainingIterations = this.config.maxIterations;

    while (remainingIterations > 0) {
      remainingIterations--;

      const response = await this.adapter.complete(history, tools, this.config);

      // Plain text response (no tool calls) — treat as final answer
      if (response.toolCalls.length === 0) {
        answer = response.content;
        terminationReason = "no_tool_call";
        break;
      }

      const toolCall = response.toolCalls[0]!;
      const callKey = JSON.stringify({ tool: toolCall.name, args: toolCall.args });

      // Loop detection: same tool + same args as previous call
      if (
        recentCalls.length >= 1 &&
        recentCalls[recentCalls.length - 1]?.tool === toolCall.name &&
        recentCalls[recentCalls.length - 1]?.args ===
          JSON.stringify(toolCall.args)
      ) {
        loopDetectionFired = true;
        remainingIterations = Math.max(0, remainingIterations - 2);
        history.push({
          role: "user",
          content: `You just called ${toolCall.name} with the same arguments again. Try a different approach — use a different tool, change your search terms, or call final_answer or not_found if you have exhausted your options.`,
        });
        continue;
      }

      recentCalls.push({ tool: toolCall.name, args: JSON.stringify(toolCall.args) });
      if (recentCalls.length > 3) recentCalls.shift();

      // Emit status signal
      const statusEntry = STATUS_MAP[toolCall.name];
      if (statusEntry && onStatus) {
        onStatus({
          phase: statusEntry.phase,
          message: statusEntry.message,
          iteration: this.config.maxIterations - remainingIterations,
          tool: toolCall.name,
        });
      }

      const callStart = Date.now();
      const result = await repl.execute(toolCall);
      const callDuration = Date.now() - callStart;

      // Check for terminal sentinels before recording — final_answer and
      // not_found are signaling tools, not retrieval calls, so they're
      // excluded from the trace.
      if (result === SENTINEL_NOT_FOUND) {
        answer = "";
        found = false;
        terminationReason = "not_found_tool";
        break;
      }

      if (result.startsWith(SENTINEL_FINAL)) {
        answer = result.slice(SENTINEL_FINAL.length);
        terminationReason = "final_tool";
        break;
      }

      // Record the retrieval call
      trace.push({
        iteration: this.config.maxIterations - remainingIterations,
        tool: toolCall.name,
        args: toolCall.args,
        resultPreview: result.slice(0, 200),
        durationMs: callDuration,
      });

      // Append assistant turn with the tool call
      history.push({
        role: "assistant",
        content: response.content,
        toolCalls: [toolCall],
      });

      // Append tool result
      history.push({
        role: "tool",
        content: result,
        toolName: toolCall.name,
      });

      void callKey;
    }

    // Max iterations failsafe: try to synthesize a best-effort answer
    if (terminationReason === "max_iterations") {
      answer = await this._synthesize(history, tools);
    }

    return {
      answer,
      found,
      iterations: this.config.maxIterations - remainingIterations,
      toolCallTrace: trace,
      terminationReason,
      loopDetectionFired,
      totalDurationMs: Date.now() - startTime,
    };
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
    _tools: Tool[]
  ): Promise<string> {
    const synthesis: Message[] = [
      ...history,
      {
        role: "user",
        content:
          "You have reached the maximum number of steps. Synthesize your best answer from what you have gathered so far. Respond with plain text only — no tool calls.",
      },
    ];

    const response = await this.adapter.complete(synthesis, [], this.config);

    // If the model emitted tool-call syntax despite tools being suppressed,
    // retry once with an explicit plain-text-only instruction.
    if (response.toolCalls.length > 0 || looksLikeToolCall(response.content)) {
      const retry = await this.adapter.complete(
        [
          ...synthesis,
          {
            role: "user",
            content:
              "Plain text only. Do not call any tools. Write your answer as a single paragraph.",
          },
        ],
        [],
        this.config
      );
      const text = retry.content.trim();
      return text || "[synthesis failed]";
    }

    return response.content.trim() || "[synthesis failed]";
  }
}

function looksLikeToolCall(text: string): boolean {
  const t = text.trim();
  return (
    t.includes("<tool_call>") ||
    (t.startsWith("[") && t.includes('"name"'))
  );
}
