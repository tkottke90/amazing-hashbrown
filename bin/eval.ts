#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { OpenAIEmbeddings } from '@langchain/openai';
import {
  runEval,
  bootEvaluations,
  getEvaluationsStore,
  loadSuites,
  loadSuite,
  getFailureCategory,
  getScoredScenarios,
  loadBaselineFile,
  findBaselineEntry,
  compareToBaseline,
  writeResultYaml,
  type Suite,
  type SkillExpansionMiddlewareLike,
  type SkillGatedToolsMiddlewareLike,
  type BaselineFile,
  type BaselineVerdict,
  type EvalRun,
} from '../lib/evaluations/src/index.js';
import {
  applyEvalDeterminism,
  createProviderFromConfig,
  describeSampling,
  resolveProviderConfig,
} from '../api/src/services/provider-factory.js';
import { env } from '../api/src/config/env.js';
import { createSkillExpansionMiddleware } from '../api/src/agents/skill-expansion.middleware.js';
import { createSkillGatedToolsMiddleware } from '../api/src/agents/skill-gated-tools.middleware.js';
import { GATED_SKILL_REGISTRATIONS } from '../api/src/agents/gated-skill-registrations.js';
import { bootSkillsManager } from '../api/src/services/skills-manager.js';
import { filterHarnessSections } from '../api/src/agents/system-prompt.js';
import { extractRequestedToolIds, buildRequiredToolBlocks } from '../api/src/agents/tool-syntax.js';
import { evalTools, buildEvalSystemPrompt } from './eval-setup.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    seed: { type: 'string' },
    temperature: { type: 'string' },
    ci: { type: 'boolean', default: false },
    'no-html': { type: 'boolean', default: false },
    'llm-review': { type: 'boolean', default: false },
    'check-baseline': { type: 'boolean', default: false },
    'baseline-slug': { type: 'string' },
  },
  strict: false,
});

// --suite is optional: when omitted, every suite discovered under suites/ is
// run in turn (see the "no --suite" branch near the bottom of this file).
if (!values.model) {
  console.error('Error: --model <name> is required');
  process.exit(2);
}

// No same-model fallback: a forgotten flag would otherwise make the judge
// silently grade the model under test. Passing the same value for both is
// still allowed as a deliberate choice — it is flagged via `biasRisk` in the
// results rather than blocked.
if (!values['judge-model']) {
  console.error(
    'Error: --judge-model <name> is required — there is no same-model fallback. ' +
      'Pass an explicit --judge-model (it may equal --model if you intend a ' +
      'deliberate self-judging run).',
  );
  process.exit(2);
}

const DEFAULT_EVAL_SEED = 42;
if (
  values.seed !== undefined &&
  !(typeof values.seed === 'string' && /^-?\d+$/.test(values.seed))
) {
  console.error(`Error: --seed must be an integer, got "${String(values.seed)}"`);
  process.exit(2);
}
const seed = values.seed === undefined ? DEFAULT_EVAL_SEED : Number(values.seed);

// Replaces the pinned temperature 0 for the model under test only (never the
// judge, so a judge's scoring stays stable and a Claude judge never receives a
// temperature it would reject).
if (
  values.temperature !== undefined &&
  !(typeof values.temperature === 'string' && /^\d+(\.\d+)?$/.test(values.temperature))
) {
  console.error(
    `Error: --temperature must be a non-negative number, got "${String(values.temperature)}"`,
  );
  process.exit(2);
}
const temperatureOverride =
  values.temperature === undefined ? undefined : Number(values.temperature);

const modelId = values.model;
const judgeModelId = values['judge-model'];

let model: ReturnType<typeof createProviderFromConfig>;
let judgeModel: ReturnType<typeof createProviderFromConfig>;
try {
  // Temperature is pinned to 0 and a fixed seed applied to the model under test
  // and the judge, regardless of what config.yaml sets for everyday chat —
  // except anthropic providers, which can't take either (see applyEvalDeterminism).
  const modelConfig = applyEvalDeterminism(resolveProviderConfig(modelId), seed, {
    temperature: temperatureOverride,
  });
  const judgeConfig = applyEvalDeterminism(resolveProviderConfig(judgeModelId), seed);
  model = createProviderFromConfig(modelConfig);
  judgeModel = createProviderFromConfig(judgeConfig);
  console.log(
    `[eval] sampling — model "${modelId}": ${describeSampling(modelConfig)}; ` +
      `judge "${judgeModelId}": ${describeSampling(judgeConfig)}`,
  );
} catch (err) {
  console.error(`Error creating model: ${String(err)}`);
  process.exit(2);
}

// Powers `semantic`-type scenarios (embedding similarity). Matches
// config.yaml's embeddings block — an OpenAI-compatible client pointed at
// baseUrl, since that's what the documented default (a `/v1`-suffixed local
// Ollama URL) targets. Omitted entirely when disabled; runEval only requires
// this for scenarios that actually use it, so other suites are unaffected.
const embeddings = env.embeddings.enabled
  ? new OpenAIEmbeddings({
      model: env.embeddings.model,
      configuration: { baseURL: env.embeddings.baseUrl },
      apiKey: process.env.OPENAI_API_KEY || 'not-needed-for-local-server',
      // The underlying openai SDK defaults embeddings requests to
      // encoding_format: "base64" regardless of any langchain option, but
      // this repo's local embedding server (embed-gemma-300m-FLM) silently
      // ignores that field and returns plain floats anyway. langchain then
      // tries to base64-decode the plain-float JSON array it got back,
      // producing a wrong-length, all-zero vector — every `semantic`-type
      // scenario scores similarity 0 regardless of actual output quality.
      // Forcing "float" makes the request match what this server actually
      // returns. Confirmed via a raw request/response test against the
      // configured baseUrl before this fix.
      encodingFormat: 'float',
    })
  : undefined;

// Try to open the SQLite store; degrade gracefully if unavailable
let store: ReturnType<typeof getEvaluationsStore> | undefined;
try {
  const db = openDatabase(env.database.path);
  bootEvaluations(db);
  store = getEvaluationsStore();
} catch {
  console.warn('[eval] Warning: could not open SQLite database — results will be YAML-only');
}

// Seeds create-workspace/create-project (and any future default skills) if
// missing — the same idempotent boot the production API server runs at
// startup (see api/src/services/skills-manager.ts). Required so
// skillExpansionMiddleware's real manager.lookup() below returns the live
// default-skills.ts body instead of always hitting its not-found catch
// branch. Safe to run unconditionally for every suite, not just
// create-workspace-project.yaml — a no-op once already seeded.
await bootSkillsManager();

// Real production middleware instances, built from the same registrations
// chat-agent.ts uses — not a reimplementation. Passed into every runEval
// call below; inert for suites whose scenarios never set `gatedSkill` (see
// runner.ts's gatedSkill branch).
const skillExpansionMiddleware = createSkillExpansionMiddleware(GATED_SKILL_REGISTRATIONS);
const skillGatedToolsMiddleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');
const suitesPath = resolve(projectRoot, 'suites');
const resultPath = resolve(projectRoot, 'eval-results');

// Loaded once up front (not per-suite in the batch loop below) so a
// malformed/missing eval-baselines.yaml fails fast before any suite runs,
// and so a 27-suite sweep doesn't re-read the same small file 27 times.
let baselineFile: BaselineFile | undefined;
if (values['check-baseline']) {
  try {
    baselineFile = loadBaselineFile(resolve(projectRoot, 'eval-baselines.yaml'));
  } catch (err) {
    console.error(`Error loading eval-baselines.yaml: ${String(err)}`);
    process.exit(4);
  }
}

// Spawns `claude -p` to review a completed run's output. Never affects the
// eval's own exit code — a missing claude binary or a non-zero exit from it
// just warns and continues, matching the graceful-degradation pattern used
// above for the optional SQLite store. Args are passed as an array (not a
// shell string), so there's no shell-quoting/injection concern regardless
// of what the prompt or file paths contain.
async function runLlmReview(opts: {
  suiteId: string;
  modelId: string;
  yamlPath: string;
  htmlPath?: string;
}): Promise<void> {
  const files = opts.htmlPath
    ? `- YAML (structured data): ${opts.yamlPath}\n- HTML (rendered report): ${opts.htmlPath}`
    : `- YAML (structured data): ${opts.yamlPath}\n(no HTML report was generated for this run — --no-html was set)`;

  const prompt = [
    `Review the evaluation results for the "${opts.suiteId}" eval suite (model: ${opts.modelId}).`,
    `Read these files:`,
    files,
    '',
    'Give a concise, terminal-readable overview (plain text, no markdown tables):',
    '- which scenarios passed/failed',
    '- any concerning pattern across the failures',
    '- for each failure, your judgment on whether it looks like a real product/prompt/model issue',
    '  versus a scenario-design issue (e.g. an overly strict or ambiguous assertion)',
  ].join('\n');

  console.log('\n🔎 Running LLM review (claude -p)...\n');

  await new Promise<void>((resolveReview) => {
    const child = spawn('claude', ['-p', prompt], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.warn(`[eval] Warning: could not run "claude" for --llm-review: ${err.message}`);
      resolveReview();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[eval] Warning: claude -p exited with code ${code}`);
      }
      resolveReview();
    });
  });
}

interface SuiteOutcome {
  suiteId: string;
  passed: boolean;
  passRate?: number;
  errored?: boolean;
  // Counts of malformed_tool_call/prose_question (issue #227) and
  // unregistered_tool_call results — see getFailureCategory. Omitted (not
  // zeroed) on the runtime-error catch
  // path below, where no results exist to count.
  failureCategoryCounts?: Record<string, number>;
  // --check-baseline outcome, set by checkBaseline() below. baselineError
  // covers both "no usable baseline" (not found/ambiguous/stale) and is
  // mutually exclusive with baselineVerdict — an error outcome never also
  // produces a verdict.
  baselineVerdict?: BaselineVerdict;
  baselineError?: string;
}

// Compares one suite run's score against eval-baselines.yaml, prints the
// verdict (or error) block, and — on a successful comparison — attaches the
// result to the run and re-writes the result YAML so it's a durable part of
// that run's record, not just a console line. `lenientNotFound` is true only
// for the no-`--suite` batch sweep, where a suite simply having no baseline
// entry for this provider isn't an error, just nothing to report; in
// single-`--suite` mode the same situation is a hard error (the user asked
// to check this one suite specifically).
async function checkBaseline(
  run: EvalRun,
  resultsForYaml: Parameters<typeof writeResultYaml>[1],
  file: BaselineFile,
  opts: { lenientNotFound: boolean },
): Promise<{ verdict?: BaselineVerdict; error?: string }> {
  const found = findBaselineEntry(file, run.suiteId, {
    provider: modelId,
    slug: values['baseline-slug'] as string | undefined,
  });

  if ('error' in found) {
    if (found.error === 'not_found' && opts.lenientNotFound) {
      return {};
    }
    const message =
      found.error === 'ambiguous'
        ? `ambiguous baseline for suite "${run.suiteId}", provider "${modelId}" — candidates: ${found.candidates
            .map((slug) => `${slug} (model: ${file[run.suiteId]![slug]!.model})`)
            .join(', ')} — pass --baseline-slug to disambiguate`
        : `no baseline on file for suite "${run.suiteId}", provider "${modelId}"`;
    console.error(`[baseline] error: ${message}`);
    return { error: message };
  }

  const { slug, entry } = found;
  const current = { score: run.passedScenarios, total: run.scoredScenarios ?? run.totalScenarios };
  const comparison = compareToBaseline(current, entry);

  if (comparison.stale) {
    const message = `baseline for "${run.suiteId}"/"${slug}" was recorded against ${entry.total} scenarios, this run scored ${current.total} — re-run /auto-update-baseline`;
    console.error(`[baseline] error: ${message}`);
    return { error: message };
  }

  console.log(`[baseline] ${run.suiteId} / ${slug}`);
  console.log(`  Current:   ${current.score}  (this run)`);
  console.log(
    `  Baseline:  ${entry.score} ± ${entry.stdev}  (mean ± stdev, n=${entry.rounds}, min ${entry.min} / max ${entry.max})`,
  );
  console.log(`  Verdict:   ${comparison.verdict}`);

  run.baseline = {
    slug,
    provider: entry.provider,
    judgeModel: entry.judgeModel,
    baselineScore: entry.score,
    baselineStdev: entry.stdev,
    baselineMin: entry.min,
    baselineMax: entry.max,
    baselineTotal: entry.total,
    currentScore: current.score,
    delta: comparison.delta,
    verdict: comparison.verdict,
  };
  await writeResultYaml(run, resultsForYaml, resultPath);

  return { verdict: comparison.verdict };
}

// Shared by runOneSuite's per-suite print and the full-sweep summary table,
// so the same counts aren't formatted two different ways.
function formatFailureCategoryCounts(counts: Record<string, number> | undefined): string {
  const entries = Object.entries(counts ?? {});
  return entries.length > 0 ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : '';
}

// Runs one suite end to end (eval + printed summary + optional --llm-review)
// and reports the outcome rather than exiting the process itself, so the
// "run everything" branch below can keep going after one suite errors
// instead of aborting the whole batch.
async function runOneSuite(
  suiteId: string,
  preloadedSuite?: Suite | null,
  lenientBaselineNotFound = false,
): Promise<SuiteOutcome> {
  try {
    // The suite's system prompt (simulated AGENT.md / task / workspace context,
    // appliesHarnessSystemPrompt opt-out, ambient-context splice) is assembled in
    // eval-setup.ts so bin/eval-stream-trace.ts builds the identical one.
    const suite = preloadedSuite ?? (await loadSuite(suiteId, { bundledPath: suitesPath }));
    const systemPrompt = buildEvalSystemPrompt(suite);
    const result = await runEval({
      suiteId,
      model,
      modelId,
      judgeModel,
      judgeModelId,
      tools: evalTools,
      systemPrompt,
      filterHarnessSections,
      extractRequestedToolIds,
      buildRequiredToolBlocks,
      embeddings,
      suitePaths: { bundledPath: suitesPath },
      resultPath,
      ci: values.ci,
      noHtml: values['no-html'],
      store,
      // Cast through the narrow *Like interfaces lib/evaluations declares
      // (it only peer-depends on @langchain/core, not langchain — the
      // package these real instances' richer types live in). Verified safe
      // against both hook bodies — see runner.ts's SkillExpansionMiddlewareLike/
      // SkillGatedToolsMiddlewareLike doc comments; do not "fix" this into
      // something more type-strict without re-reading that reasoning.
      skillExpansionMiddleware: skillExpansionMiddleware as unknown as SkillExpansionMiddlewareLike,
      skillGatedToolsMiddleware:
        skillGatedToolsMiddleware as unknown as SkillGatedToolsMiddlewareLike,
    });

    const { run } = result;
    const icon = run.passed ? '✓' : '✗';
    const status = run.passed ? 'PASS' : 'FAIL';
    const failureCategoryCounts = result.results.reduce<Record<string, number>>((acc, r) => {
      const category = getFailureCategory(r.details);
      if (category) acc[category] = (acc[category] ?? 0) + 1;
      return acc;
    }, {});

    const scored = getScoredScenarios(run);
    const skipped = run.totalScenarios - scored;
    const skipNote = skipped > 0 ? ` (${skipped} skipped)` : '';

    console.log(`\n${icon} ${status} — ${run.suiteId}`);
    console.log(
      `  Pass rate: ${(run.passRate * 100).toFixed(1)}%  (${run.passedScenarios}/${scored} scenarios)${skipNote}`,
    );
    const categoryLine = formatFailureCategoryCounts(failureCategoryCounts);
    if (categoryLine) console.log(`  ⚠ ${categoryLine}`);
    console.log(`  Latency:   ${run.totalLatencyMs}ms`);
    console.log(`  Cost:      $${run.estimatedCostUsd.toFixed(6)}`);
    console.log(`\n  Result:    ${result.yamlPath}`);
    if (result.htmlPath) console.log(`  Report:    ${result.htmlPath}`);
    console.log();

    let baselineOutcome: { verdict?: BaselineVerdict; error?: string } = {};
    if (baselineFile) {
      baselineOutcome = await checkBaseline(run, result.results, baselineFile, {
        lenientNotFound: lenientBaselineNotFound,
      });
    }

    if (values['llm-review']) {
      await runLlmReview({
        suiteId: run.suiteId,
        modelId,
        yamlPath: result.yamlPath,
        htmlPath: result.htmlPath,
      });
    }

    return {
      suiteId,
      passed: run.passed,
      passRate: run.passRate,
      failureCategoryCounts,
      baselineVerdict: baselineOutcome.verdict,
      baselineError: baselineOutcome.error,
    };
  } catch (err) {
    console.error(`\nRuntime error running suite "${suiteId}": ${String(err)}`);
    return { suiteId, passed: false, errored: true };
  }
}

if (typeof values.suite === 'string' && values.suite.length > 0) {
  // Single explicit suite — preserve the original exit-code contract exactly
  // (3 for a runtime error, 0/1 for pass/fail) rather than folding it into
  // the batch summary below. runOneSuite() catches its own errors, so there's
  // nothing left that can throw here.
  const outcome = await runOneSuite(values.suite, undefined, false);
  if (outcome.baselineError) process.exit(4);
  if (outcome.baselineVerdict === 'REGRESSION') process.exit(5);
  process.exit(outcome.errored ? 3 : outcome.passed ? 0 : 1);
}

// No --suite given: discover and run every suite under suites/, in a stable
// (alphabetical) order — loadSuites' own discovery order depends on
// filesystem readdir order, which isn't guaranteed.
const suites = await loadSuites({ bundledPath: suitesPath });
const suiteIds = [...suites.keys()].sort();
if (suiteIds.length === 0) {
  console.error(`Error: no suites found in ${suitesPath}`);
  process.exit(2);
}

console.log(`No --suite given — running all ${suiteIds.length} suite(s): ${suiteIds.join(', ')}`);

const outcomes: SuiteOutcome[] = [];
for (const suiteId of suiteIds) {
  // Batch mode: a suite with no baseline entry for this provider is skipped
  // silently (lenientBaselineNotFound: true) rather than treated as an
  // error — see checkBaseline's doc comment.
  outcomes.push(await runOneSuite(suiteId, suites.get(suiteId), true));
}

console.log('─'.repeat(50));
console.log('Summary\n');
for (const o of outcomes) {
  const icon = o.errored ? '⚠' : o.passed ? '✓' : '✗';
  const label = o.errored ? 'ERROR' : o.passed ? 'PASS' : 'FAIL';
  const rate = o.passRate !== undefined ? `  ${(o.passRate * 100).toFixed(1)}%` : '';
  const categoryLine = formatFailureCategoryCounts(o.failureCategoryCounts);
  const counts = categoryLine ? `  (${categoryLine})` : '';
  const baselineNote = o.baselineError
    ? `  [baseline: ${o.baselineError}]`
    : o.baselineVerdict
      ? `  [baseline: ${o.baselineVerdict}]`
      : '';
  console.log(`  ${icon} ${o.suiteId.padEnd(24)} ${label}${rate}${counts}${baselineNote}`);
}
const passedCount = outcomes.filter((o) => o.passed).length;
console.log(`\n${passedCount}/${outcomes.length} suite(s) passed\n`);

const hasBaselineError = outcomes.some((o) => o.baselineError);
const hasRegression = outcomes.some((o) => o.baselineVerdict === 'REGRESSION');
process.exit(hasBaselineError ? 4 : hasRegression ? 5 : outcomes.every((o) => o.passed) ? 0 : 1);
