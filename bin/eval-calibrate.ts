#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootEvaluations, getEvaluationsStore, loadSuites } from '../lib/evaluations/src/index.js';
import { env } from '../api/src/config/env.js';
import {
  promptKeypress,
  promptForNotes,
  printDivider,
} from '../lib/evaluations/src/executors/human.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'run-id': { type: 'string' },
  },
  strict: false,
});

if (!values['run-id']) {
  console.error('Error: --run-id <id> is required');
  process.exit(2);
}

const projectRoot = resolve(import.meta.url.replace('file://', ''), '../..');

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

const judgeResults = store.findJudgeResultsForRun(runId);
if (judgeResults.length === 0) {
  console.log('No llm-judge results for this run.');
  process.exit(0);
}

const suitesPath = resolve(projectRoot, 'suites');
const suites = await loadSuites({ bundledPath: suitesPath });
const suite = suites.get(run.suiteId);

let idx = 1;
for (const result of judgeResults) {
  if (result.details.type !== 'llm-judge') continue; // narrows for TS; store query already filtered by type

  const scenario = suite?.scenarios.find(
    (s) => s.id === result.scenarioId && s.type === 'llm-judge',
  );
  if (!scenario || scenario.type !== 'llm-judge') {
    console.warn(`Skipping ${result.scenarioId} — scenario not found in suite`);
    continue;
  }

  process.stdout.write(`\nJudge Calibration — ${idx} of ${judgeResults.length}\n`);
  printDivider();
  process.stdout.write(`\nInput:\n  ${scenario.input}\n`);
  process.stdout.write(`\nOutput:\n`);
  for (const line of result.actualOutput.split('\n')) {
    process.stdout.write(`  ${line}\n`);
  }
  printDivider();
  process.stdout.write(`Rubric:\n  ${scenario.rubric}\n`);
  printDivider();

  // Blind: the judge's own score/reasoning is withheld until after the
  // reviewer answers, so the reviewer isn't anchored by it.
  process.stdout.write(`\n[P] Pass    [F] Fail\n\n> `);
  const key = await promptKeypress(['p', 'f']);
  const humanPassed = key === 'p';
  const reviewerNotes = await promptForNotes();

  process.stdout.write(
    `\nJudge verdict: ${result.passed ? 'Pass' : 'Fail'} (score ${result.details.score})\n`,
  );
  process.stdout.write(`Judge reasoning: ${result.details.reasoning}\n`);

  store.recordJudgeCalibration({
    id: crypto.randomUUID(),
    resultId: result.id,
    judgeScore: result.details.score,
    judgePassed: result.passed,
    humanPassed,
    reviewerNotes: reviewerNotes || undefined,
    gradedAt: new Date().toISOString(),
  });

  idx++;
}

const summary = store.getCalibrationSummary(runId);
console.log(`\n✓ Calibrated ${summary.total} llm-judge result(s) for run ${runId}`);
console.log(
  `  Agreement: ${(summary.agreementRate * 100).toFixed(1)}% (${summary.agreeCount}/${summary.total})`,
);

if (summary.disagreements.length > 0) {
  console.log(`\nDisagreements:`);
  for (const d of summary.disagreements) {
    console.log(
      `  - ${d.scenarioId}: judge=${d.judgePassed ? 'Pass' : 'Fail'} (score ${d.judgeScore}), you=${d.humanPassed ? 'Pass' : 'Fail'}`,
    );
    if (d.reviewerNotes) console.log(`      notes: ${d.reviewerNotes}`);
  }
}

if (summary.agreementRate < 0.85) {
  console.log(
    `\n⚠ Agreement below 85% — fix the rubric or its few-shot examples before trusting this judge.`,
  );
}
