#!/usr/bin/env tsx
// Determinism probe: runs the same suite(s) against the same model(s) and judge
// several times and diffs per-scenario pass/fail across the runs. With
// temperature 0 and a fixed seed pinned (see applyEvalDeterminism), identical
// runs should agree; anything that doesn't is reported with whether the judge
// was involved. Runs are sequential — local model servers can't take parallel
// eval load without distorting latency and, for some, results.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  analyzeDeterminism,
  formatProbeReport,
  parseResultPath,
  probeExitCode,
  readResultYaml,
} from '../lib/evaluations/src/index.js';
import type { ProbeEntry, ProbeRun } from '../lib/evaluations/src/index.js';

const DEFAULT_RUNS = 3;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    suite: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    runs: { type: 'string' },
    seed: { type: 'string' },
  },
  strict: false,
});

const csv = (raw: unknown): string[] =>
  typeof raw === 'string'
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

const suites = csv(values.suite);
const models = csv(values.model);
const judgeModel = typeof values['judge-model'] === 'string' ? values['judge-model'] : undefined;

if (suites.length === 0 || models.length === 0 || !judgeModel) {
  console.error(
    'Error: --suite <a,b,...>, --model <p1,p2,...> and --judge-model <name> are all required\n' +
      'Usage: npm run eval:probe -- --suite wiki-navigation,create-workspace-project \\\n' +
      '         --model ollama,lemonade --judge-model claude [--runs 3] [--seed 42]',
  );
  process.exit(2);
}

if (values.runs !== undefined && !(typeof values.runs === 'string' && /^\d+$/.test(values.runs))) {
  console.error(`Error: --runs must be an integer, got "${String(values.runs)}"`);
  process.exit(2);
}
const runs = values.runs === undefined ? DEFAULT_RUNS : Number(values.runs);
if (runs < 2) {
  console.error('Error: --runs must be at least 2 — one run has nothing to compare against');
  process.exit(2);
}

if (
  values.seed !== undefined &&
  !(typeof values.seed === 'string' && /^-?\d+$/.test(values.seed))
) {
  console.error(`Error: --seed must be an integer, got "${String(values.seed)}"`);
  process.exit(2);
}

const projectRoot = resolve(fileURLToPath(import.meta.url), '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = join(projectRoot, 'eval-logs', `probe-${stamp}`);
mkdirSync(logDir, { recursive: true });

const entries: ProbeEntry[] = [];
const totalRuns = suites.length * models.length * runs;
let completed = 0;
let aborted = false;

// Grouped by model, then suite, so a local server isn't asked to swap models
// between consecutive runs.
for (const model of models) {
  if (aborted) break;
  for (const suite of suites) {
    if (aborted) break;
    const collected: ProbeRun[] = [];
    let errored: string | undefined;

    for (let n = 1; n <= runs; n += 1) {
      completed += 1;
      const label = `[${completed}/${totalRuns}] ${model} / ${suite} run ${n}/${runs}`;
      console.log(`${label} ...`);

      const args = [
        'run',
        'eval',
        '--',
        '--suite',
        suite,
        '--model',
        model,
        '--judge-model',
        judgeModel,
        '--ci',
        '--no-html',
      ];
      if (values.seed !== undefined) args.push('--seed', String(values.seed));

      const proc = spawnSync('npm', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
      writeFileSync(join(logDir, `${model}-${suite}-${n}.log`), output);

      if (proc.error) {
        errored = `could not start npm: ${proc.error.message}`;
        break;
      }
      // 2 is a usage/config error from bin/eval.ts (bad provider name, missing
      // flag) — it would repeat on every run, so stop the whole probe.
      if (proc.status === 2) {
        console.error(`  eval exited 2 (usage/config error); aborting. See ${logDir}`);
        console.error(output.split('\n').slice(-8).join('\n'));
        aborted = true;
        break;
      }
      const resultPath = parseResultPath(output);
      if (proc.status === 3 || !resultPath) {
        errored = `run ${n} produced no result (exit ${String(proc.status)})`;
        break;
      }
      try {
        const loaded = await readResultYaml(resultPath);
        collected.push(loaded);
        console.log(
          `  exit ${String(proc.status)}, passed ${loaded.run.passedScenarios}/${loaded.run.scoredScenarios ?? loaded.run.totalScenarios}`,
        );
      } catch (err) {
        errored = `could not read ${resultPath}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }

    if (aborted) break;
    entries.push(
      errored === undefined
        ? { suiteId: suite, model, status: 'analyzed', analysis: analyzeDeterminism(collected) }
        : { suiteId: suite, model, status: 'errored', reason: errored },
    );
  }
}

console.log(`\n${formatProbeReport(entries, { aborted })}`);
const jsonPath = join(logDir, 'probe.json');
writeFileSync(
  jsonPath,
  JSON.stringify(
    { startedAt: stamp, suites, models, judgeModel, runs, seed: values.seed, entries },
    null,
    2,
  ),
);
console.log(`\nLogs and probe.json: ${logDir}`);

process.exit(aborted ? 2 : probeExitCode(entries));
