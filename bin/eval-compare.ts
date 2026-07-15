#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import {
  bootEvaluations,
  getEvaluationsStore,
  compareRuns,
  writeComparisonHtml,
} from '../lib/evaluations/src/index.js';
import { env } from '../api/src/config/env.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'run-a': { type: 'string' },
    'run-b': { type: 'string' },
  },
  strict: false,
});

if (!values['run-a'] || !values['run-b']) {
  console.error('Error: --run-a <id> and --run-b <id> are required');
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

const runA = store.findRunById(values['run-a']);
const runB = store.findRunById(values['run-b']);

if (!runA) { console.error(`Error: Run A "${values['run-a']}" not found`); process.exit(2); }
if (!runB) { console.error(`Error: Run B "${values['run-b']}" not found`); process.exit(2); }

const resultsA = store.findResultsByRunId(runA.id);
const resultsB = store.findResultsByRunId(runB.id);

const comparison = compareRuns(runA, resultsA, runB, resultsB);
const htmlPath = await writeComparisonHtml(comparison, resultPath);

const { summary } = comparison;
console.log(`\nComparison: ${comparison.suiteId}`);
console.log(`  Run A: ${runA.model} @ ${runA.startedAt}`);
console.log(`  Run B: ${runB.model} @ ${runB.startedAt}`);
console.log(`\n  Improved:  ${summary.improved}`);
console.log(`  Regressed: ${summary.regressed}`);
console.log(`  Unchanged: ${summary.unchanged}`);
if (summary.added) console.log(`  Added:     ${summary.added}`);
if (summary.removed) console.log(`  Removed:   ${summary.removed}`);
console.log(`\n  Report:    ${htmlPath}`);
