#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import {
  bootEvaluations,
  getEvaluationsStore,
  writeReviewManifest,
  loadSuites,
} from '../lib/evaluations/src/index.js';
import { env } from '../api/src/config/env.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'run-id': { type: 'string' },
    detached: { type: 'boolean', default: false },
  },
  strict: false,
});

if (!values['run-id']) {
  console.error('Error: --run-id <id> is required');
  process.exit(2);
}

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');
const resultPath = resolve(projectRoot, 'eval-results');

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase(env.database.path);
  bootEvaluations(db);
} catch (err) {
  console.error(`Error opening database: ${String(err)}`);
  process.exit(3);
}

const store = getEvaluationsStore();
const runId = values['run-id'];
const run = store.findRunById(runId);
if (!run) {
  console.error(`Error: Run "${runId}" not found in database`);
  process.exit(2);
}

const pending = store.findPendingHumanResults(runId);
if (pending.length === 0) {
  console.log('No pending human results for this run.');
  process.exit(0);
}

if (values.detached) {
  const suitesPath = resolve(projectRoot, 'suites');
  const suites = await loadSuites({ bundledPath: suitesPath });
  const manifestPath = await writeReviewManifest(run, pending, suites, resultPath);
  console.log(`Review manifest written to: ${manifestPath}`);
  console.log(`\nFill in the "response" field for each review entry, then run:`);
  console.log(`  npm run eval:submit -- --manifest ${manifestPath}`);
  process.exit(0);
}

// Interactive TUI
const { runHumanInteractive } = await import('../lib/evaluations/src/executors/human.js');
const suitesPath = resolve(projectRoot, 'suites');
const suites = await loadSuites({ bundledPath: suitesPath });
const suite = suites.get(run.suiteId);

let idx = 1;
for (const result of pending) {
  const scenario = suite?.scenarios.find((s) => s.id === result.scenarioId && s.type === 'human');
  if (!scenario || scenario.type !== 'human') {
    console.warn(`Skipping ${result.scenarioId} — scenario not found in suite`);
    continue;
  }

  const details = await runHumanInteractive(scenario, result.actualOutput, idx++, pending.length);
  store.updateHumanResult(result.id, {
    status: details.status as 'approved' | 'rejected',
    response: details.response ?? '',
    reviewerNotes: details.reviewerNotes,
  });
}

console.log(`\n✓ Scored ${pending.length} human result(s) for run ${runId}`);
