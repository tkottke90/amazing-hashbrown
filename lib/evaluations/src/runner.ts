import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';
import { loadSuite, type SuiteLoaderConfig } from './loader.js';
import { runDeterministic } from './executors/deterministic.js';
import { runSemantic } from './executors/semantic.js';
import { runLlmJudge } from './executors/llm-judge.js';
import { runStructured } from './executors/structured.js';
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
// Jest-style live progress — one line per scenario, colored pass/fail icon
// plus duration. In a real terminal, an in-progress "RUNS" line is
// overwritten in place once the scenario finishes; when output isn't a TTY
// (piped, redirected to a file, CI logs) only the completed line is printed,
// so captured logs don't end up full of \r control characters.
// ---------------------------------------------------------------------------

const isTTY = Boolean(process.stdout.isTTY);

function colorize(code: string, text: string): string {
  return isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const green = (s: string) => colorize('32', s);
const red = (s: string) => colorize('31', s);
const yellow = (s: string) => colorize('33', s);
const dim = (s: string) => colorize('2', s);

function logScenarioStart(scenario: Scenario): void {
  if (!isTTY) return;
  process.stdout.write(`  ${dim('RUNS')} ${scenario.name}`);
}

function formatScenarioLine(scenario: Scenario, result: ScenarioResult): string {
  if (result.details.type === 'human') {
    const label = result.details.status === 'skipped' ? '(skipped)' : '(awaiting human review)';
    return `  ${yellow('○')} ${scenario.name} ${dim(label)}`;
  }
  const icon = result.passed ? green('✓') : red('✕');
  return `  ${icon} ${scenario.name} ${dim(`(${result.latencyMs}ms)`)}`;
}

function logScenarioResult(scenario: Scenario, result: ScenarioResult): void {
  const line = formatScenarioLine(scenario, result);
  if (isTTY) {
    // \r returns to column 0, \x1b[2K clears the in-progress "RUNS" line.
    process.stdout.write(`\r\x1b[2K${line}\n`);
  } else {
    console.log(line);
  }
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

async function executeScenario(
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

function computeRunSummary(
  results: ScenarioResult[],
  suite: Suite,
  runId: string,
  modelId: string,
  judgeModelId: string,
  startedAt: string,
): EvalRun {
  const scorable = results.filter(
    (r) =>
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
  const results: Array<ScenarioResult & { _humanScenario?: HumanScenario }> = [];
  for (const scenario of suite.scenarios) {
    logScenarioStart(scenario);
    const result = await executeScenario(scenario, suite, runId, config, humanIndex);
    logScenarioResult(scenario, result);
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
