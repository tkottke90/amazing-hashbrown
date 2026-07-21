import type { BaseChatModel, BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { loadSuite, type SuiteLoaderConfig } from './loader.js';
import { runDeterministic } from './executors/deterministic.js';
import { runSemantic } from './executors/semantic.js';
import { runLlmJudge } from './executors/llm-judge.js';
import { runStructured } from './executors/structured.js';
import { runToolCall, type InvokedToolCall } from './executors/tool-call.js';
import { runToolSequence } from './executors/tool-sequence.js';
import { runHumanSkipped, runHumanPending, runHumanInteractive } from './executors/human.js';
import type {
  EvalRun,
  ScenarioResult,
  Suite,
  Scenario,
  DeterministicScenario,
  SemanticScenario,
  LlmJudgeScenario,
  StructuredScenario,
  ToolCallScenario,
  ToolSequenceScenario,
  HumanScenario,
} from './schemas.js';
import type { EvaluationsStore } from './store.js';

export interface RunConfig {
  suiteId: string;
  model: BaseChatModel;
  modelId: string;
  judgeModel: BaseChatModel;
  judgeModelId: string;
  embeddings?: Embeddings;
  tools?: BindToolsInput[];
  /** Prepended as a SystemMessage for tool-call/tool-sequence scenarios only. */
  systemPrompt?: string;
  suitePaths: SuiteLoaderConfig;
  resultPath: string;
  ci?: boolean;
  noHtml?: boolean;
  store?: EvaluationsStore;
}

export interface RunResult {
  run: EvalRun;
  results: ScenarioResult[];
  yamlPath: string;
  htmlPath?: string;
}

// ---------------------------------------------------------------------------
// Jest-style live progress board — the full scenario list prints up front
// (pending scenarios marked "-"), and each line updates in place as its
// scenario starts running and then completes, so progress against the whole
// suite is visible the entire time, not just a trailing log of finished
// scenarios. In a real terminal this uses ANSI cursor movement to rewrite
// individual lines; when output isn't a TTY (piped, redirected to a file, CI
// logs) cursor movement can't do anything useful, so it falls back to
// printing only each completed line as it finishes — the same behavior as
// before, and safe for captured logs.
// ---------------------------------------------------------------------------

const isTTY = Boolean(process.stdout.isTTY);

function colorize(code: string, text: string): string {
  return isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const green = (s: string) => colorize('32', s);
const red = (s: string) => colorize('31', s);
const yellow = (s: string) => colorize('33', s);
const dim = (s: string) => colorize('2', s);

function formatPendingLine(scenario: Scenario): string {
  return `  ${dim('-')} ${scenario.name}`;
}

function formatRunningLine(scenario: Scenario): string {
  return `  ${dim('›')} ${scenario.name}`;
}

function formatDoneLine(scenario: Scenario, result: ScenarioResult): string {
  if (result.details.type === 'skipped') {
    return `  ${yellow('S')} ${scenario.name} ${dim('(skipped)')}`;
  }
  if (result.details.type === 'human') {
    const label = result.details.status === 'skipped' ? '(skipped)' : '(awaiting human review)';
    return `  ${yellow('○')} ${scenario.name} ${dim(label)}`;
  }
  const icon = result.passed ? green('✓') : red('✕');
  return `  ${icon} ${scenario.name} ${dim(`(${result.latencyMs}ms)`)}`;
}

interface ProgressBoard {
  markRunning(index: number): void;
  markDone(index: number, result: ScenarioResult): void;
}

function createProgressBoard(scenarios: Scenario[]): ProgressBoard {
  const lines = scenarios.map(formatPendingLine);

  if (!isTTY) {
    // No cursor control available — print each completed line as it happens.
    return {
      markRunning: () => {},
      markDone: (index, result) => {
        console.log(formatDoneLine(scenarios[index]!, result));
      },
    };
  }

  for (const line of lines) console.log(line);

  function rewrite(index: number, line: string): void {
    lines[index] = line;
    const linesFromBottom = lines.length - index;
    process.stdout.write(`\x1b[${linesFromBottom}A`); // up to the target line
    process.stdout.write(`\r\x1b[2K${line}`); // clear it and write the new content
    process.stdout.write(`\x1b[${linesFromBottom}B\r`); // back down to the bottom, column 0
  }

  return {
    markRunning(index) {
      rewrite(index, formatRunningLine(scenarios[index]!));
    },
    markDone(index, result) {
      rewrite(index, formatDoneLine(scenarios[index]!, result));
    },
  };
}

function extractContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'content' in raw) {
    const content = (raw as { content: unknown }).content;
    if (typeof content === 'string') return content;
    return JSON.stringify(content);
  }
  return String(raw);
}

async function invokeModel(
  model: BaseChatModel,
  input: string,
): Promise<{ content: string; latencyMs: number }> {
  const start = Date.now();
  const response = await model.invoke(input);
  const latencyMs = Date.now() - start;
  return { content: extractContent(response), latencyMs };
}

async function invokeStructuredModel(
  model: BaseChatModel,
  input: string,
  outputSchema: Record<string, unknown>,
): Promise<{ parsed: unknown; content: string; latencyMs: number }> {
  const start = Date.now();
  const parsed = await model.withStructuredOutput(outputSchema).invoke(input);
  const latencyMs = Date.now() - start;
  return { parsed, content: JSON.stringify(parsed), latencyMs };
}

// Seeds a synthetic conversation history — as if `priorTurns` had already
// happened — for tool-sequence scenarios. Each turn becomes its own
// AIMessage(tool_call) + ToolMessage(result) pair, in order, so the final
// invoke() sees a conversation where those tool calls already completed.
export function buildSeededMessages(
  input: string,
  priorTurns: ToolSequenceScenario['priorTurns'],
): BaseMessage[] {
  const messages: BaseMessage[] = [new HumanMessage(input)];
  priorTurns.forEach((turn, i) => {
    const toolCallId = `eval-seed-${i}`;
    messages.push(
      new AIMessage({
        content: '',
        tool_calls: [{ id: toolCallId, name: turn.tool, args: turn.args }],
      }),
    );
    messages.push(
      new ToolMessage({ tool_call_id: toolCallId, content: JSON.stringify(turn.result) }),
    );
  });
  return messages;
}

// Prepends a SystemMessage ahead of the given input for tool-call/tool-sequence
// scenarios when a systemPrompt is configured; returns input unchanged otherwise.
export function withSystemPrompt(
  input: string | BaseMessage[],
  systemPrompt?: string,
): string | BaseMessage[] {
  if (!systemPrompt) return input;
  const messages = typeof input === 'string' ? [new HumanMessage(input)] : input;
  return [new SystemMessage(systemPrompt), ...messages];
}

// Distinct from InvokedToolCall — populated when the model attempts a tool
// call that fails to parse/validate against the tool's schema. A non-empty
// invalidToolCalls with empty toolCalls means "the model tried and failed,"
// not "the model chose not to act" — those look identical if you only read
// response.tool_calls and response.content, which is all this file used to do.
export interface InvalidToolCallInfo {
  name?: string;
  args?: string;
  error?: string;
}

export interface ExtractedToolCallData {
  toolCalls: InvokedToolCall[];
  invalidToolCalls: InvalidToolCallInfo[];
  // Raw passthrough, not normalized — response_metadata's shape is
  // provider-specific (Ollama uses done_reason, OpenAI uses finish_reason,
  // etc.), and guessing a single canonical field name would be wrong more
  // often than it'd help.
  responseMetadata?: Record<string, unknown>;
  // Ollama "thinking" models (e.g. qwen3) can put chain-of-thought here
  // instead of .content — if the model spends its whole generation
  // "thinking" without a distinct final-answer segment, .content is
  // legitimately empty while this holds everything it actually generated.
  reasoningContent?: string;
  content: string;
}

export function extractToolCallData(response: AIMessage): ExtractedToolCallData {
  const toolCalls: InvokedToolCall[] = (response.tool_calls ?? []).map((call) => ({
    name: call.name,
    args: call.args,
  }));
  const invalidToolCalls: InvalidToolCallInfo[] = (response.invalid_tool_calls ?? []).map(
    (call) => ({ name: call.name, args: call.args, error: call.error }),
  );
  const responseMetadata =
    response.response_metadata && Object.keys(response.response_metadata).length > 0
      ? response.response_metadata
      : undefined;
  const reasoningContent =
    typeof response.additional_kwargs?.reasoning_content === 'string' &&
    response.additional_kwargs.reasoning_content !== ''
      ? response.additional_kwargs.reasoning_content
      : undefined;
  return {
    toolCalls,
    invalidToolCalls,
    responseMetadata,
    reasoningContent,
    content: extractContent(response),
  };
}

async function invokeToolCallModel(
  model: BaseChatModel,
  input: string | BaseMessage[],
  tools: BindToolsInput[],
): Promise<{
  toolCalls: InvokedToolCall[];
  invalidToolCalls: InvalidToolCallInfo[];
  responseMetadata?: Record<string, unknown>;
  reasoningContent?: string;
  content: string;
  latencyMs: number;
}> {
  if (!model.bindTools) {
    throw new Error(
      'the configured model does not support bindTools — required for tool-call scenarios',
    );
  }
  const start = Date.now();
  const response = await model.bindTools(tools).invoke(input);
  const latencyMs = Date.now() - start;
  return { ...extractToolCallData(response), latencyMs };
}

export async function executeScenario(
  scenario: Scenario,
  suite: Suite,
  runId: string,
  config: RunConfig,
  _humanIndex: { count: number; total: number },
): Promise<ScenarioResult> {
  const baseResult = {
    id: crypto.randomUUID(),
    runId,
    scenarioId: scenario.id,
    suiteId: suite.suite.id,
    estimatedCostUsd: 0,
  };

  if (scenario.skip) {
    return {
      ...baseResult,
      passed: false,
      score: null,
      actualOutput: '',
      latencyMs: 0,
      details: { type: 'skipped' },
    };
  }

  try {
    if (scenario.type === 'deterministic') {
      const s = scenario as DeterministicScenario;
      const { content, latencyMs } = await invokeModel(config.model, s.input);
      const details = runDeterministic(s, content);
      return {
        ...baseResult,
        passed: details.passed,
        score: details.passed ? 1 : 0,
        actualOutput: content,
        latencyMs,
        details,
      };
    }

    if (scenario.type === 'semantic') {
      const s = scenario as SemanticScenario;
      if (!config.embeddings) {
        throw new Error('embeddings are required for semantic scenarios');
      }
      const { content, latencyMs } = await invokeModel(config.model, s.input);
      const details = await runSemantic(s, content, config.embeddings);
      const passed = details.similarity >= details.threshold;
      return {
        ...baseResult,
        passed,
        score: details.similarity,
        actualOutput: content,
        latencyMs,
        details,
      };
    }

    if (scenario.type === 'llm-judge') {
      const s = scenario as LlmJudgeScenario;
      const { content, latencyMs } = await invokeModel(config.model, s.input);
      const details = await runLlmJudge(
        s,
        content,
        config.modelId,
        config.judgeModel,
        config.judgeModelId,
      );
      const passed = details.score >= s.minScore;
      return {
        ...baseResult,
        passed,
        score: details.score / 10,
        actualOutput: content,
        latencyMs,
        details,
      };
    }

    if (scenario.type === 'structured') {
      const s = scenario as StructuredScenario;
      const { parsed, content, latencyMs } = await invokeStructuredModel(
        config.model,
        s.input,
        s.outputSchema,
      );
      const details = runStructured(s, parsed);
      const passed = details.score >= s.minScore;
      return {
        ...baseResult,
        passed,
        score: details.score,
        actualOutput: content,
        latencyMs,
        details,
      };
    }

    if (scenario.type === 'tool-call') {
      const s = scenario as ToolCallScenario;
      if (!config.tools || config.tools.length === 0) {
        throw new Error('tools are required for tool-call scenarios');
      }
      const {
        toolCalls,
        invalidToolCalls,
        responseMetadata,
        reasoningContent,
        content,
        latencyMs,
      } = await invokeToolCallModel(
        config.model,
        withSystemPrompt(s.input, config.systemPrompt),
        config.tools,
      );
      const details = {
        ...runToolCall(s, toolCalls),
        invalidToolCalls,
        responseMetadata,
        reasoningContent,
      };
      const passed = details.toolCalled === s.tool && details.score >= s.minScore;
      return {
        ...baseResult,
        passed,
        score: details.score,
        actualOutput: content,
        latencyMs,
        details,
      };
    }

    if (scenario.type === 'tool-sequence') {
      const s = scenario as ToolSequenceScenario;
      if (!config.tools || config.tools.length === 0) {
        throw new Error('tools are required for tool-sequence scenarios');
      }
      const seeded = buildSeededMessages(s.input, s.priorTurns);
      const {
        toolCalls,
        invalidToolCalls,
        responseMetadata,
        reasoningContent,
        content,
        latencyMs,
      } = await invokeToolCallModel(
        config.model,
        withSystemPrompt(seeded, config.systemPrompt),
        config.tools,
      );
      const details = {
        ...runToolSequence(s, toolCalls),
        invalidToolCalls,
        responseMetadata,
        reasoningContent,
      };
      const passed = details.toolCalled === s.tool && details.score >= s.minScore;
      return {
        ...baseResult,
        passed,
        score: details.score,
        actualOutput: content,
        latencyMs,
        details,
      };
    }

    if (scenario.type === 'human') {
      const s = scenario as HumanScenario;
      if (config.ci) {
        return {
          ...baseResult,
          passed: false,
          score: null,
          actualOutput: '',
          latencyMs: 0,
          details: runHumanSkipped(),
        };
      }

      // In non-ci mode, run the model to get the actual output but defer scoring
      // (interactive TUI runs after all automated scenarios complete)
      const { content, latencyMs } = await invokeModel(config.model, s.input);
      return {
        ...baseResult,
        passed: false,
        score: null,
        actualOutput: content,
        latencyMs,
        details: runHumanPending(),
        _humanScenario: s,
      } as ScenarioResult & { _humanScenario: HumanScenario };
    }

    throw new Error(`Unknown scenario type: ${(scenario as Scenario).type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[eval] scenario "${scenario.id}" (${scenario.type}) errored: ${message}`);
    return {
      ...baseResult,
      passed: false,
      score: 0,
      actualOutput: `[scenario error] ${message}`,
      latencyMs: 0,
      details: {
        type: 'deterministic',
        match: 'exact',
        expected: '',
        passed: false,
      },
    };
  }
}

export function computeRunSummary(
  results: ScenarioResult[],
  suite: Suite,
  runId: string,
  modelId: string,
  judgeModelId: string,
  startedAt: string,
): EvalRun {
  const scorable = results.filter(
    (r) =>
      r.details.type !== 'skipped' &&
      !(
        r.details.type === 'human' &&
        (r.details.status === 'pending' || r.details.status === 'skipped')
      ),
  );
  const passedScenarios = scorable.filter((r) => r.passed).length;
  const passRate = scorable.length > 0 ? passedScenarios / scorable.length : 1;
  const threshold = suite.suite.passingThreshold ?? 1;
  const passed = passRate >= threshold;
  const totalLatencyMs = results.reduce((sum, r) => sum + r.latencyMs, 0);
  const estimatedCostUsd = results.reduce((sum, r) => sum + r.estimatedCostUsd, 0);

  return {
    id: runId,
    suiteId: suite.suite.id,
    model: modelId,
    judgeModel: judgeModelId,
    startedAt,
    endedAt: new Date().toISOString(),
    passed,
    passRate,
    totalScenarios: results.length,
    passedScenarios,
    totalLatencyMs,
    estimatedCostUsd,
  };
}

export async function runEval(config: RunConfig): Promise<RunResult> {
  const suite = await loadSuite(config.suiteId, config.suitePaths);
  if (!suite) {
    throw new Error(`Suite "${config.suiteId}" not found in ${config.suitePaths.bundledPath}`);
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const humanIndex = { count: 0, total: suite.scenarios.filter((s) => s.type === 'human').length };

  // Execute all scenarios; collect partial results
  console.log(`\n${suite.suite.name}`);
  const board = createProgressBoard(suite.scenarios);
  const results: Array<ScenarioResult & { _humanScenario?: HumanScenario }> = [];
  for (const [index, scenario] of suite.scenarios.entries()) {
    board.markRunning(index);
    const result = await executeScenario(scenario, suite, runId, config, humanIndex);
    board.markDone(index, result);
    results.push(result as ScenarioResult & { _humanScenario?: HumanScenario });
  }
  console.log();

  // Interactive human scoring TUI (only when not in CI mode)
  if (!config.ci) {
    const humanPending = results.filter(
      (r) => r.details.type === 'human' && r.details.status === 'pending' && r._humanScenario,
    );
    let idx = 1;
    for (const r of humanPending) {
      const s = r._humanScenario!;
      const humanDetails = await runHumanInteractive(s, r.actualOutput, idx++, humanPending.length);
      r.details = humanDetails;
      r.passed = humanDetails.status === 'approved';
      r.score = r.passed ? 1 : 0;
    }
  }

  // Strip internal _humanScenario field
  const cleanResults: ScenarioResult[] = results.map(({ _humanScenario: _, ...r }) => r);

  const run = computeRunSummary(
    cleanResults,
    suite,
    runId,
    config.modelId,
    config.judgeModelId,
    startedAt,
  );

  // Dual-write: SQLite (if store provided) and YAML
  if (config.store) {
    try {
      config.store.saveRun(run, cleanResults);
    } catch (err) {
      console.warn(`[eval] Failed to save to SQLite: ${String(err)}`);
    }
  }

  // Import serializer lazily to avoid circular deps at type level
  const { writeResultYaml, writeResultHtml } = await import('./serializer.js');

  let yamlPath: string;
  try {
    yamlPath = await writeResultYaml(run, cleanResults, config.resultPath);
  } catch (err) {
    throw new Error(`Failed to write YAML result: ${String(err)}`);
  }

  let htmlPath: string | undefined;
  if (!config.noHtml) {
    try {
      htmlPath = await writeResultHtml(run, cleanResults, suite, config.resultPath);
    } catch (err) {
      console.warn(`[eval] Failed to write HTML report: ${String(err)}`);
    }
  }

  return { run, results: cleanResults, yamlPath, htmlPath };
}
