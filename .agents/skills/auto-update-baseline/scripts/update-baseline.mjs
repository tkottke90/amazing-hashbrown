#!/usr/bin/env node
// Writes/overwrites one (suite, provider-model slug) entry in
// eval-baselines.yaml, in place — preserving the file's header comment
// and every other suite/slug entry already in it. This is the only thing
// in the auto-update-baseline skill that touches the YAML file directly,
// so hand-editing the structure stays in one place rather than being
// re-implemented per invocation.
//
// This script does NOT run evals or compute the average itself — it just
// records a number it's handed. The calling agent is responsible for
// running the frozen rounds (via auto-eval-loop's run-eval-round.sh),
// reading each round's result YAML, and averaging `passedScenarios`
// before calling this.
//
// Usage:
//   node update-baseline.mjs \
//     --suite <suite-id> --slug <provider-model-slug> \
//     --provider <config.yaml provider name> \
//     --model <human-readable model name> \
//     --judge-model <provider name used as judge> \
//     --score <averaged passedScenarios, may be fractional> \
//     --total <scoredScenarios from the last round> \
//     --rounds <N rounds averaged> \
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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> auto-update-baseline/ -> skills/ -> .agents/ -> repo root
const repoRoot = path.resolve(__dirname, '../../../..');

// Resolve `yaml` from the evaluations workspace, which declares it as a
// direct dependency — safer than assuming npm workspace hoisting put it
// at the repo root too.
const requireFromEvaluations = createRequire(path.join(repoRoot, 'lib/evaluations/package.json'));
const YAML = requireFromEvaluations('yaml');

const { values: args } = parseArgs({
  options: {
    suite: { type: 'string' },
    slug: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    score: { type: 'string' },
    total: { type: 'string' },
    rounds: { type: 'string' },
    branch: { type: 'string' },
    commit: { type: 'string' },
    file: { type: 'string' },
    'updated-at': { type: 'string' },
  },
});

const required = ['suite', 'slug', 'provider', 'model', 'judge-model', 'score', 'total', 'rounds', 'branch', 'commit'];
const missing = required.filter((key) => args[key] === undefined || args[key] === '');
if (missing.length > 0) {
  console.error(`update-baseline.mjs: missing required --${missing.join(', --')}`);
  process.exit(1);
}

const filePath = args.file ? path.resolve(args.file) : path.join(repoRoot, 'eval-baselines.yaml');

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

const suiteId = args.suite;
const slug = args.slug;

if (!doc.hasIn(['baselines'])) {
  doc.set('baselines', {});
}
if (!doc.hasIn(['baselines', suiteId])) {
  doc.setIn(['baselines', suiteId], {});
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

const entry = {
  provider: args.provider,
  model: args.model,
  judgeModel: args['judge-model'],
  score: Number(args.score),
  total: Number.parseInt(args.total, 10),
  rounds: Number.parseInt(args.rounds, 10),
  updatedAt: args['updated-at'] ?? new Date().toISOString(),
  branch: args.branch,
  commit: args.commit,
};

// A baseline update REPLACES the prior entry for this (suite, slug) key —
// it is not additive history (see the design doc / SKILL.md).
doc.setIn(['baselines', suiteId, slug], entry);

writeFileSync(filePath, String(doc));

console.log(`old_score=${oldScore === null || oldScore === undefined ? 'none' : oldScore}`);
console.log(`new_score=${entry.score}`);
console.log(`file=${filePath}`);
