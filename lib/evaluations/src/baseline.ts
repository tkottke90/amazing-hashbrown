import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export type BaselineVerdict = 'WITHIN_BASELINE' | 'REGRESSION' | 'IMPROVEMENT';

// Mirrors one baselines.<suiteId>.<slug> entry in eval-baselines.yaml — see
// that file's own header comment for what each field means and how it's
// computed (by /auto-update-baseline). Validated on load so a hand-edited or
// stale entry fails loudly instead of silently comparing against undefined.
export const BaselineEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  judgeModel: z.string(),
  score: z.number(),
  min: z.number(),
  max: z.number(),
  stdev: z.number(),
  total: z.number().int(),
  rounds: z.number().int(),
  updatedAt: z.string(),
  branch: z.string(),
  commit: z.string(),
});
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;

export type BaselineFile = Record<string, Record<string, BaselineEntry>>;

const BaselineFileSchema = z.object({
  baselines: z.record(z.string(), z.record(z.string(), BaselineEntrySchema)),
});

/**
 * Loads and validates eval-baselines.yaml. Throws (rather than returning a
 * partial/best-effort result) on unparseable YAML or a malformed entry —
 * this file is the sole source of truth for "is this a regression," so a
 * silently-ignored bad entry would defeat the point.
 */
export function loadBaselineFile(filePath: string): BaselineFile {
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML in ${filePath}: ${String(err)}`);
  }

  const result = BaselineFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid baseline entry in ${filePath}:\n${result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result.data.baselines;
}

export type FindBaselineEntryResult =
  | { slug: string; entry: BaselineEntry }
  | { error: 'not_found' | 'ambiguous'; candidates: string[] };

/**
 * Resolves which eval-baselines.yaml entry a --check-baseline run should
 * compare against. An explicit slug always wins and bypasses provider
 * matching entirely. Otherwise, auto-match by provider: eval-baselines.yaml
 * entries record the exact config.yaml provider name a baseline was run
 * against (the same string bin/eval.ts's --model flag takes), so for most
 * suites there's exactly one candidate.
 */
export function findBaselineEntry(
  file: BaselineFile,
  suiteId: string,
  opts: { provider: string; slug?: string },
): FindBaselineEntryResult {
  const suiteEntries = file[suiteId] ?? {};

  if (opts.slug !== undefined) {
    const entry = suiteEntries[opts.slug];
    return entry ? { slug: opts.slug, entry } : { error: 'not_found', candidates: [] };
  }

  const matches = Object.entries(suiteEntries).filter(
    ([, entry]) => entry.provider === opts.provider,
  );

  if (matches.length === 0) return { error: 'not_found', candidates: [] };
  if (matches.length > 1) {
    return { error: 'ambiguous', candidates: matches.map(([slug]) => slug) };
  }
  const [slug, entry] = matches[0]!;
  return { slug, entry };
}

export type CompareToBaselineResult =
  | { stale: true }
  | {
      stale: false;
      verdict: BaselineVerdict;
      delta: number;
      thresholdLow: number;
      thresholdHigh: number;
    };

/**
 * Classifies a single run's score against a baseline's mean ± stdev (from
 * its N frozen rounds). A 1-stdev band: below it is a REGRESSION, above it
 * an IMPROVEMENT, otherwise WITHIN_BASELINE. For a stdev: 0 entry both
 * thresholds collapse to the mean itself, so any deviation at all flags —
 * deliberate, since stdev: 0 means the suite was fully deterministic across
 * every frozen round, and `total` mismatching means the suite's scenario
 * count has changed since this baseline was recorded, so the comparison
 * isn't meaningful at all (checked before any score math).
 */
export function compareToBaseline(
  current: { score: number; total: number },
  entry: BaselineEntry,
): CompareToBaselineResult {
  if (current.total !== entry.total) {
    return { stale: true };
  }

  const thresholdLow = entry.score - entry.stdev;
  const thresholdHigh = entry.score + entry.stdev;
  const delta = current.score - entry.score;

  let verdict: BaselineVerdict;
  if (current.score < thresholdLow) {
    verdict = 'REGRESSION';
  } else if (current.score > thresholdHigh) {
    verdict = 'IMPROVEMENT';
  } else {
    verdict = 'WITHIN_BASELINE';
  }

  return { stale: false, verdict, delta, thresholdLow, thresholdHigh };
}
