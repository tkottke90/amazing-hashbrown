#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { OpenAIEmbeddings } from '@langchain/openai';
import { runEval, bootEvaluations, getEvaluationsStore } from '../lib/evaluations/src/index.js';
import { createProvider } from '../api/src/services/provider-factory.js';
import { env } from '../api/src/config/env.js';
import { askUserTool } from '../api/src/agents/tools/ask-user.tool.js';
import { uploadImageTool } from '../api/src/agents/tools/upload-image.tool.js';
import { wikiSearchTool } from '../api/src/agents/tools/wiki-search.tool.js';
import { wikiReadPageTool } from '../api/src/agents/tools/wiki-read-page.tool.js';
import { wikiLocateTool } from '../api/src/agents/tools/wiki-locate.tool.js';
import { wikiOrientTool } from '../api/src/agents/tools/wiki-orient.tool.js';
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
  uploadImageTool,
  wikiSearchTool,
  wikiReadPageTool,
  wikiLocateTool,
  wikiOrientTool,
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

if (!values.suite) {
  console.error('Error: --suite <id> is required');
  process.exit(2);
}
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

try {
  const result = await runEval({
    suiteId: values.suite,
    model,
    modelId,
    judgeModel,
    judgeModelId,
    tools: evalTools,
    systemPrompt: buildSystemPrompt(),
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

  process.exit(run.passed ? 0 : 1);
} catch (err) {
  console.error(`\nRuntime error: ${String(err)}`);
  process.exit(3);
}
