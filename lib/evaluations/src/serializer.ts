import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify, parse } from 'yaml';
import nunjucks from 'nunjucks';
import {
  EvalRunSchema,
  ScenarioResultSchema,
  ScoringSchema,
  type EvalRun,
  type ScenarioResult,
  type Suite,
} from './schemas.js';
import type { ComparisonResult } from './comparator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '../templates');

let njkEnv: nunjucks.Environment | null = null;
function getNjkEnv(): nunjucks.Environment {
  if (!njkEnv) {
    njkEnv = nunjucks.configure(TEMPLATES_DIR, { autoescape: true });
  }
  return njkEnv;
}

function sanitizeTimestamp(ts: string): string {
  return ts.replace(/:/g, '-').replace(/\./g, '-');
}

// ---------------------------------------------------------------------------
// YAML result files
// ---------------------------------------------------------------------------

export async function writeResultYaml(
  run: EvalRun,
  results: ScenarioResult[],
  resultPath: string,
): Promise<string> {
  await mkdir(resultPath, { recursive: true });
  const ts = sanitizeTimestamp(run.startedAt);
  const filePath = join(resultPath, `${run.suiteId}-${ts}.yaml`);
  const data = { run, results };
  await writeFile(filePath, stringify(data), 'utf-8');
  return filePath;
}

export async function readResultYaml(
  filePath: string,
): Promise<{ run: EvalRun; results: ScenarioResult[] }> {
  const raw = await readFile(filePath, 'utf-8');
  const data = parse(raw) as { run: unknown; results: unknown[] };
  const run = EvalRunSchema.parse(data.run);
  const results = (data.results as unknown[]).map((r) => ScenarioResultSchema.parse(r));
  return { run, results };
}

// ---------------------------------------------------------------------------
// HTML reports
// ---------------------------------------------------------------------------

export async function writeResultHtml(
  run: EvalRun,
  results: ScenarioResult[],
  suite: Suite,
  resultPath: string,
): Promise<string> {
  await mkdir(resultPath, { recursive: true });
  const styles = await readFile(join(TEMPLATES_DIR, 'base.css'), 'utf-8');
  const env = getNjkEnv();
  const html = env.render('result.njk', {
    run,
    results,
    suiteName: suite.suite.name,
    styles,
  });
  const ts = sanitizeTimestamp(run.startedAt);
  const filePath = join(resultPath, `${run.suiteId}-${ts}.html`);
  await writeFile(filePath, html, 'utf-8');
  return filePath;
}

export async function writeComparisonHtml(
  comparison: ComparisonResult,
  resultPath: string,
): Promise<string> {
  await mkdir(resultPath, { recursive: true });
  const styles = await readFile(join(TEMPLATES_DIR, 'base.css'), 'utf-8');
  const env = getNjkEnv();
  const html = env.render('comparison.njk', { comparison, styles });
  const filePath = join(
    resultPath,
    `comparison-${comparison.runA.id.slice(0, 8)}-vs-${comparison.runB.id.slice(0, 8)}.html`,
  );
  await writeFile(filePath, html, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Review manifests
// ---------------------------------------------------------------------------

export interface ReviewEntry {
  resultId: string;
  scenarioId: string;
  input: string;
  actualOutput: string;
  rubric: string;
  scoring: ReturnType<typeof ScoringSchema.parse>;
  response: string;
  reviewerNotes: string;
}

export interface ReviewManifest {
  runId: string;
  reviews: ReviewEntry[];
}

export async function writeReviewManifest(
  run: EvalRun,
  pendingResults: ScenarioResult[],
  suites: Map<string, Suite>,
  resultPath: string,
): Promise<string> {
  await mkdir(resultPath, { recursive: true });
  const suite = suites.get(run.suiteId);

  const reviews: ReviewEntry[] = pendingResults.map((r) => {
    const scenario = suite?.scenarios.find((s) => s.id === r.scenarioId && s.type === 'human');
    const humanScenario = scenario?.type === 'human' ? scenario : undefined;
    return {
      resultId: r.id,
      scenarioId: r.scenarioId,
      input: humanScenario?.input ?? '',
      actualOutput: r.actualOutput,
      rubric: humanScenario?.rubric ?? '',
      scoring: humanScenario?.scoring ?? {
        type: 'choice',
        options: [
          { key: 'y', label: 'Yes', pass: true },
          { key: 'n', label: 'No', pass: false },
        ],
      },
      response: '',
      reviewerNotes: '',
    };
  });

  const manifest: ReviewManifest = { runId: run.id, reviews };
  const filePath = join(resultPath, `${run.id}-review.json`);
  await writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
  return filePath;
}

export async function readReviewManifest(filePath: string): Promise<ReviewManifest> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw) as ReviewManifest;
}
