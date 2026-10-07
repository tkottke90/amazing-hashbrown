#!/usr/bin/env node
// Writes/overwrites one (suite, provider-model slug) entry in
// eval-baselines.yaml, in place — preserving the file's header comment
// and every other suite/slug entry already in it. This is the only thing
// in the auto-update-baseline skill that touches the YAML file directly,
// so hand-editing the structure stays in one place rather than being
// re-implemented per invocation.
//
// This script computes score (mean), min, max, and stdev (population,
// ÷N) from the raw round scores it's handed — the calling agent is only
// responsible for running the frozen rounds (via auto-eval-loop's
// run-eval-round.sh) and reading each round's passedScenarios.
//
// Usage:
//   node update-baseline.mjs \
//     --suite <suite-id> --slug <provider-model-slug> \
//     --provider <config.yaml provider name> \
//     --model <human-readable model name> \
//     --judge-model <provider name used as judge> \
//     --round-scores <comma-separated passedScenarios, e.g. "15,16,15,17,15"> \
//     --total <scoredScenarios from the last round> \
//     --branch <git branch> --commit <git SHA> \
//     [--file <path to eval-baselines.yaml, default: repo root>]
//
// Prints, one per line, nothing else on stdout:
//   old_score=<previous score for this (suite, slug), or "none">
//   new_score=<the score just written>
//   file=<absolute path written>
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> auto-update-baseline/ -> skills/ -> .agents/ -> repo root
const repoRoot = path.resolve(__dirname, '../../../..');

// Resolve `yaml` from the evaluations workspace, which declares it as a
// direct dependency — safer than assuming npm workspace hoisting put it
// at the repo root too.
const requireFromEvaluations = createRequire(path.join(repoRoot, 'lib/evaluations/package.json'));
const YAML = requireFromEvaluations('yaml');

// Parses "15,16,15,17,15" into [15,16,15,17,15]. Throws a descriptive
// Error (no process.exit — callers decide how to report it) when the
// input is missing, empty, or contains a non-finite value.
export function parseRoundScores(raw) {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      '--round-scores is required and must contain at least one score (comma-separated, e.g. "15,16,15,17,15")',
    );
  }
  const tokens = raw.split(',').map((t) => t.trim());
  return tokens.map((token, i) => {
    if (token === '') {
      throw new Error(`--round-scores has an empty value at position ${i + 1} (got "${raw}")`);
    }
    const n = Number(token);
    if (!Number.isFinite(n)) {
      throw new Error(`--round-scores has a non-numeric value "${token}" at position ${i + 1}`);
    }
    return n;
  });
}

// Pure arithmetic: mean, min, max, population stdev (÷ N, not ÷ N-1) —
// same variance formula as lib/skills-manager/src/internal/evals.ts's
// computeStats(), kept local here since nothing there is exported for
// reuse outside that workspace.
export function computeRoundStats(scores) {
  const rounds = scores.length;
  const score = scores.reduce((a, b) => a + b, 0) / rounds;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const variance = scores.reduce((sum, v) => sum + (v - score) ** 2, 0) / rounds;
  return { score, min, max, stdev: Math.sqrt(variance), rounds };
}

// Reads filePath (or the fallback skeleton if it doesn't exist yet),
// sets baselines[suiteId][slug] = entry (replace-on-write), writes it
// back, and returns the previous score for that key (or null).
export function writeBaselineEntry({ filePath, suiteId, slug, entry }) {
  const fallback = [
    '# baselines populated by the auto-update-baseline skill.',
    '# See the schema comments this file normally carries at its head —',
    '# they were missing when this script ran, so only the data key was',
    '# restored here. Re-add the header comment by hand if you want it back.',
    'baselines: {}',
    '',
  ].join('\n');

  const raw = existsSync(filePath) ? readFileSync(filePath, 'utf8') : fallback;
  const doc = YAML.parseDocument(raw);

  if (!doc.hasIn(['baselines'])) {
    doc.set('baselines', {});
  }
  if (!doc.hasIn(['baselines', suiteId])) {
    // doc.createNode() converts the plain object into a real YAMLMap node;
    // setIn(path, {}) alone stores a bare object the yaml library can't
    // later setIn()-traverse into, throwing "Expected YAML collection".
    doc.setIn(['baselines', suiteId], doc.createNode({}));
  }

  // Read the previous value (if any) before overwriting, purely for the
  // old_score= line the caller reports back to the user. doc.getIn() may
  // hand back either a plain JS object or a YAMLMap node depending on the
  // yaml package version's unwrapping behavior for collections, so handle
  // both rather than assuming one.
  const previousEntry = doc.getIn(['baselines', suiteId, slug]);
  let oldScore = null;
  if (previousEntry != null) {
    if (typeof previousEntry.toJSON === 'function') {
      oldScore = previousEntry.toJSON()?.score ?? null;
    } else if (typeof previousEntry === 'object') {
      oldScore = previousEntry.score ?? null;
    }
  }

  // A baseline update REPLACES the prior entry for this (suite, slug) key —
  // it is not additive history (see the design doc / SKILL.md).
  doc.setIn(['baselines', suiteId, slug], entry);

  writeFileSync(filePath, String(doc));

  return { oldScore };
}

function main() {
  const { values: args } = parseArgs({
    options: {
      suite: { type: 'string' },
      slug: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'judge-model': { type: 'string' },
      'round-scores': { type: 'string' },
      total: { type: 'string' },
      branch: { type: 'string' },
      commit: { type: 'string' },
      file: { type: 'string' },
      'updated-at': { type: 'string' },
    },
  });

  const required = [
    'suite',
    'slug',
    'provider',
    'model',
    'judge-model',
    'round-scores',
    'total',
    'branch',
    'commit',
  ];
  const missing = required.filter((key) => args[key] === undefined || args[key] === '');
  if (missing.length > 0) {
    console.error(`update-baseline.mjs: missing required --${missing.join(', --')}`);
    process.exit(1);
  }

  let scores;
  try {
    scores = parseRoundScores(args['round-scores']);
  } catch (err) {
    console.error(`update-baseline.mjs: ${err.message}`);
    process.exit(1);
  }
  const stats = computeRoundStats(scores);

  const filePath = args.file ? path.resolve(args.file) : path.join(repoRoot, 'eval-baselines.yaml');

  const entry = {
    provider: args.provider,
    model: args.model,
    judgeModel: args['judge-model'],
    score: stats.score,
    min: stats.min,
    max: stats.max,
    stdev: stats.stdev,
    total: Number.parseInt(args.total, 10),
    rounds: stats.rounds,
    updatedAt: args['updated-at'] ?? new Date().toISOString(),
    branch: args.branch,
    commit: args.commit,
  };

  const { oldScore } = writeBaselineEntry({ filePath, suiteId: args.suite, slug: args.slug, entry });

  console.log(`old_score=${oldScore === null || oldScore === undefined ? 'none' : oldScore}`);
  console.log(`new_score=${entry.score}`);
  console.log(`file=${filePath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
