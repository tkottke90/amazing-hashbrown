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
  type Suite,
} from '../lib/evaluations/src/index.js';
import { createProvider } from '../api/src/services/provider-factory.js';
import { env } from '../api/src/config/env.js';
import { askUserTool } from '../api/src/agents/tools/ask-user.tool.js';
import { shellExecTool } from '../api/src/agents/tools/shell-exec.tool.js';
import { uploadImageTool } from '../api/src/agents/tools/upload-image.tool.js';
import { wikiSearchTool } from '../api/src/agents/tools/wiki-search.tool.js';
import { wikiReadPageTool } from '../api/src/agents/tools/wiki-read-page.tool.js';
import { wikiLocateTool } from '../api/src/agents/tools/wiki-locate.tool.js';
import { wikiOrientTool } from '../api/src/agents/tools/wiki-orient.tool.js';
import { makeWikiCreatePageTool } from '../api/src/agents/tools/wiki-create-page.tool.js';
import { wikiLintTool } from '../api/src/agents/tools/wiki-lint.tool.js';
import { makeWikiUpdatePageTool } from '../api/src/agents/tools/wiki-update-page.tool.js';
import { makeWikiAddCrossLinkTool } from '../api/src/agents/tools/wiki-add-cross-link.tool.js';
import { makeWikiRebaselineSourceTool } from '../api/src/agents/tools/wiki-rebaseline-source.tool.js';
import { wikiRegisterDomainTool } from '../api/src/agents/tools/wiki-register-domain.tool.js';
import { webFetchTool } from '../api/src/agents/tools/web-fetch.tool.js';
import { makeCreateWorkspaceTool } from '../api/src/agents/tools/create-workspace.tool.js';
import { makeCreateProjectTool } from '../api/src/agents/tools/create-project.tool.js';
import { buildSystemPrompt } from '../api/src/agents/system-prompt.js';
import { fakeGenerateImageTool } from './eval-fixtures.js';

// The static built-in tool set the production chat agent binds (see
// api/src/agents/chat-agent.ts) — used to give tool-call eval scenarios the
// same choices the real agent has. MCP tools are excluded: they're
// dynamic/live-server-dependent, which would make the eval non-deterministic
// to run. fakeGenerateImageTool is an eval-only fixture (see
// eval-fixtures.ts) — never part of the production agent's tool set.
const evalTools = [
  askUserTool,
  // Safe to bind here even though it can run real commands: tool-call and
  // tool-sequence scenarios only inspect response.tool_calls — the runner
  // never executes the bound tools (see invokeToolCallModel in runner.ts).
  shellExecTool,
  uploadImageTool,
  wikiSearchTool,
  wikiReadPageTool,
  wikiLocateTool,
  wikiOrientTool,
  wikiLintTool,
  // Unrestricted (no allowedWikiId), matching production's global-chat agent
  // — the eval runner only inspects proposed tool_calls against seeded
  // priorTurns context, it never actually executes a tool, so this can't
  // exercise the allowedWikiId restriction itself (that's what
  // wwrite-005/006-009's seeded rejection results are for).
  makeWikiCreatePageTool(),
  makeWikiUpdatePageTool(),
  makeWikiAddCrossLinkTool(),
  makeWikiRebaselineSourceTool(),
  wikiRegisterDomainTool,
  webFetchTool,
  // Skill-gated in production (see chat-agent.ts's skillGatedToolsMiddleware)
  // — that gating is verified by skill-gated-tools.middleware.test.ts, not
  // by evals, since this harness binds a fixed tool list per scenario and
  // never runs the real middleware pipeline. Included here unconditionally
  // so create-workspace-project.yaml's scenarios have them as an option,
  // matching how every other tool here is unconditionally available.
  makeCreateWorkspaceTool(),
  makeCreateProjectTool(),
  fakeGenerateImageTool,
];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    ci: { type: 'boolean', default: false },
    'no-html': { type: 'boolean', default: false },
    'llm-review': { type: 'boolean', default: false },
  },
  strict: false,
});

// --suite is optional: when omitted, every suite discovered under suites/ is
// run in turn (see the "no --suite" branch near the bottom of this file).
if (!values.model) {
  console.error('Error: --model <name> is required');
  process.exit(2);
}

const modelId = values.model;
const judgeModelId = values['judge-model'] ?? values.model;

let model: ReturnType<typeof createProvider>;
let judgeModel: ReturnType<typeof createProvider>;
try {
  model = createProvider(modelId);
  judgeModel = createProvider(judgeModelId);
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

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');
const suitesPath = resolve(projectRoot, 'suites');
const resultPath = resolve(projectRoot, 'eval-results');

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
}

// Runs one suite end to end (eval + printed summary + optional --llm-review)
// and reports the outcome rather than exiting the process itself, so the
// "run everything" branch below can keep going after one suite errors
// instead of aborting the whole batch.
async function runOneSuite(suiteId: string, preloadedSuite?: Suite | null): Promise<SuiteOutcome> {
  try {
    // Suites can opt into a simulated "AGENT.md" instruction set
    // (suite.simulatedUserInstructions — see suites/instruction-hierarchy.yaml)
    // to exercise buildSystemPrompt()'s user-instructions branch, which no
    // suite exercises by default (bin/eval.ts otherwise always passes no
    // argument, harness-only, for reproducibility). Real config/AGENT.md
    // content never reaches eval runs — only what's authored directly in
    // suite YAML.
    //
    // suite.appliesHarnessSystemPrompt (default true) lets a suite opt OUT
    // entirely — see suites/after-agent.yaml/thread-titles.yaml, whose
    // scenarios model a different production code path (after-agent.ts,
    // generateTitleHandler) that never attaches this prompt in real usage.
    const suite = preloadedSuite ?? (await loadSuite(suiteId, { bundledPath: suitesPath }));
    const systemPrompt =
      suite?.suite.appliesHarnessSystemPrompt === false
        ? undefined
        : buildSystemPrompt(suite?.suite.simulatedUserInstructions);

    const result = await runEval({
      suiteId,
      model,
      modelId,
      judgeModel,
      judgeModelId,
      tools: evalTools,
      systemPrompt,
      embeddings,
      suitePaths: { bundledPath: suitesPath },
      resultPath,
      ci: values.ci,
      noHtml: values['no-html'],
      store,
    });

    const { run } = result;
    const icon = run.passed ? '✓' : '✗';
    const status = run.passed ? 'PASS' : 'FAIL';

    console.log(`\n${icon} ${status} — ${run.suiteId}`);
    console.log(
      `  Pass rate: ${(run.passRate * 100).toFixed(1)}%  (${run.passedScenarios}/${run.totalScenarios} scenarios)`,
    );
    console.log(`  Latency:   ${run.totalLatencyMs}ms`);
    console.log(`  Cost:      $${run.estimatedCostUsd.toFixed(6)}`);
    console.log(`\n  Result:    ${result.yamlPath}`);
    if (result.htmlPath) console.log(`  Report:    ${result.htmlPath}`);
    console.log();

    if (values['llm-review']) {
      await runLlmReview({
        suiteId: run.suiteId,
        modelId,
        yamlPath: result.yamlPath,
        htmlPath: result.htmlPath,
      });
    }

    return { suiteId, passed: run.passed, passRate: run.passRate };
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
  const outcome = await runOneSuite(values.suite);
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
  outcomes.push(await runOneSuite(suiteId, suites.get(suiteId)));
}

console.log('─'.repeat(50));
console.log('Summary\n');
for (const o of outcomes) {
  const icon = o.errored ? '⚠' : o.passed ? '✓' : '✗';
  const label = o.errored ? 'ERROR' : o.passed ? 'PASS' : 'FAIL';
  const rate = o.passRate !== undefined ? `  ${(o.passRate * 100).toFixed(1)}%` : '';
  console.log(`  ${icon} ${o.suiteId.padEnd(24)} ${label}${rate}`);
}
const passedCount = outcomes.filter((o) => o.passed).length;
console.log(`\n${passedCount}/${outcomes.length} suite(s) passed\n`);

process.exit(outcomes.every((o) => o.passed) ? 0 : 1);
