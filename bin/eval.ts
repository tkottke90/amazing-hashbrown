#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { runEval, bootEvaluations, getEvaluationsStore } from '../lib/evaluations/src/index.js';
import { createProvider } from '../api/src/services/provider-factory.js';
import { env } from '../api/src/config/env.js';
import { askUserTool } from '../api/src/agents/tools/ask-user.tool.js';
import { uploadImageTool } from '../api/src/agents/tools/upload-image.tool.js';
import { wikiSearchTool } from '../api/src/agents/tools/wiki-search.tool.js';
import { wikiReadPageTool } from '../api/src/agents/tools/wiki-read-page.tool.js';

// The static built-in tool set the production chat agent binds (see
// api/src/agents/chat-agent.ts) — used to give tool-call eval scenarios the
// same choices the real agent has. MCP tools are excluded: they're
// dynamic/live-server-dependent, which would make the eval non-deterministic
// to run.
const evalTools = [askUserTool, uploadImageTool, wikiSearchTool, wikiReadPageTool];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    ci: { type: 'boolean', default: false },
    'no-html': { type: 'boolean', default: false },
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

try {
  const result = await runEval({
    suiteId: values.suite,
    model,
    modelId,
    judgeModel,
    judgeModelId,
    tools: evalTools,
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

  process.exit(run.passed ? 0 : 1);
} catch (err) {
  console.error(`\nRuntime error: ${String(err)}`);
  process.exit(3);
}
