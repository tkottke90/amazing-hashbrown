#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import {
  bootEvaluations,
  getEvaluationsStore,
  readReviewManifest,
} from '../lib/evaluations/src/index.js';
import { env } from '../api/src/config/env.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    manifest: { type: 'string' },
  },
  strict: false,
});

if (!values.manifest) {
  console.error('Error: --manifest <path> is required');
  process.exit(2);
}

let db: ReturnType<typeof openDatabase>;
try {
  db = openDatabase(env.database.path);
  bootEvaluations(db);
} catch (err) {
  console.error(`Error opening database: ${String(err)}`);
  process.exit(3);
}

const store = getEvaluationsStore();
let manifest: Awaited<ReturnType<typeof readReviewManifest>>;
try {
  manifest = await readReviewManifest(values.manifest);
} catch (err) {
  console.error(`Error reading manifest: ${String(err)}`);
  process.exit(2);
}

let submitted = 0;
let skipped = 0;
for (const review of manifest.reviews) {
  if (!review.response) {
    console.warn(`Skipping ${review.scenarioId} — no response provided`);
    skipped++;
    continue;
  }
  const status = (() => {
    // Determine pass/fail from response key against scoring options
    return review.response === 'y' || review.response === 'yes' ? 'approved' : 'rejected';
  })();
  store.updateHumanResult(review.resultId, {
    status,
    response: review.response,
    reviewerNotes: review.reviewerNotes || undefined,
  });
  submitted++;
}

console.log(
  `\n✓ Submitted ${submitted} review(s)${skipped > 0 ? ` (${skipped} skipped — no response)` : ''}`,
);
