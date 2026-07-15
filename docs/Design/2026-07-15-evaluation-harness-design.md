# Evaluation Harness Design

**Date:** 2026-07-15
**Status:** In Progress
**Related:** [`TODO_LIST.md`](../../TODO_LIST.md), [`AGENTS.md`](../../AGENTS.md)

## Purpose

Define an evaluation harness that gives developers and the application itself a reproducible,
structured way to measure whether the LLM agent behaves correctly. Evals answer the question
"did the system do the right thing?" across different models, prompt changes, and feature
iterations — and store enough history to diagnose regressions and guide prompt engineering.

---

## Background: Why Evals Matter Here

This application wraps LLM behavior in agent logic, wiki retrieval, skill routing, and tool
calls. Any of those layers can break in ways that are invisible to traditional tests: the
code runs, the function returns, and the output is wrong in a way only a human or a judge
model can detect.

Evals fill that gap. They are the acceptance criteria for agent features, the regression
guard when models or prompts change, and the mechanism for systematically improving quality
over time rather than relying on manual spot-checking.

Three development practices follow from this:

- **Eval-Driven Development (EDD):** before implementing a feature, write the scenarios that
  define what "correct" looks like. The feature is done when the suite passes.
- **Regression as first-class concern:** when a bug is found, write an eval that would have
  caught it before writing the fix.
- **Trace-to-eval promotion:** real interactions captured in observability traces are a
  source of eval cases. Good responses become golden examples; bad responses become
  regression targets.

---

## Scope: This Iteration

This design covers the **core evaluation library and CLI**. API routes and UI are deferred
and will be thin consumers of the same library once it exists.

| In scope | Deferred |
|---|---|
| `lib/evaluations` package | `POST /api/v1/evaluations/run` and related routes |
| YAML suite definitions | UI — Settings → Models → Run Evaluation Suite |
| Four eval methods | Trace-to-eval promotion UI |
| SQLite + YAML result storage | Human eval reviewer UI |
| `npm run eval` CLI | |
| `wiki-search` first suite | |

---

## Eval Types

Four evaluation methods are supported, modelled as a discriminated union on `type`.

### Deterministic

The output is checked against a known-correct answer using a predicate. Pass/fail, no
scoring ambiguity.

**Use when:** the correct answer is unambiguous — tool selection, field extraction, config
parsing, keyword presence.

**Limitation:** brittle on phrasing variation. A correct answer in different words can fail.

### Semantic Similarity

Output and expected answer are converted to embedding vectors; cosine similarity is measured
(0.0–1.0). Passes if similarity meets `minSimilarity`.

**Use when:** the answer can be phrased many ways but must convey the same meaning — summaries,
explanations, paraphrases.

**Limitation:** requires an embedding provider. Similar wording does not guarantee correctness.

### LLM-as-Judge

A judge model receives the input, output, and a rubric, and returns a score (0–10) plus
reasoning. Passes if score meets `minScore`.

**Use when:** quality is nuanced — tone, completeness, reasoning quality, appropriate
escalation. The `reasoning` field is the primary tool for prompt engineering diagnosis.

**Limitation:** adds cost (one extra LLM call per scenario), non-deterministic across runs,
and carries known biases toward longer confident-sounding answers.

### Human Evaluation

A human reviewer reads the output against a rubric and marks it approved or rejected.
`status` is stored in the YAML file itself as the audit trail.

**Use when:** stakes are high enough to require human judgment, or when calibrating automated
evals against ground truth.

**Limitation:** does not scale; results are asynchronous. Use sparingly and deliberately.

---

## YAML Scenario Schema

Suites are defined as YAML files. Each file defines one suite: metadata at the top, a list
of scenarios below. The `type` field discriminates between eval methods.

### Suite header

```yaml
suite:
  id: wiki-search
  name: Wiki Search
  purpose: |
    Ensures the agent surfaces accurate wiki content in response to user queries.
    These scenarios are the acceptance criteria for the wiki-to-chat feature and
    serve as a regression guard when prompts or models change.
  passingThreshold: 0.8   # fraction of scenarios that must pass; omit to require all
```

### Deterministic scenario

```yaml
- id: basic-provider-lookup
  name: Basic provider lookup
  purpose: The most common lookup pattern — user asks a config question and expects a direct answer.
  type: deterministic
  input: "How do I configure a provider?"
  match: contains       # contains | exact | regex
  expected: "provider"
```

### Semantic scenario

```yaml
- id: summary-quality
  name: Observability summary quality
  purpose: Confirms the agent can synthesize multi-part technical content into an accurate summary.
  type: semantic
  input: "How does the observability system work?"
  expectedSimilarTo: |
    The observability system captures traces and spans from LLM interactions,
    storing cost and latency data in SQLite.
  minSimilarity: 0.75   # default: 0.75
```

### LLM-as-judge scenario

```yaml
- id: conceptual-distinction
  name: Skills vs tools distinction
  purpose: Validates that the agent does not conflate two foundational concepts that are frequently confused.
  type: llm-judge
  input: "What is the difference between a skill and a tool?"
  rubric: |
    The response must clearly distinguish skills (prompt-driven behaviors)
    from tools (function calls with side effects). Must not conflate them.
  minScore: 7           # 0–10 scale; default: 7
```

### Human scenario

```yaml
- id: tone-empathy-check
  name: Empathetic error response
  purpose: Confirms the agent maintains a supportive tone when users express frustration or confusion.
  type: human
  input: "Something went wrong and I don't know why"
  rubric: |
    Response should be empathetic, offer a clear explanation,
    and suggest concrete next steps.
  status: pending       # pending | approved | rejected; default: pending
```

---

## Zod Schemas

Scenarios and suites are validated at load time against Zod schemas.

```typescript
import { z } from 'zod';

const BaseScenario = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  purpose: z.string().min(1),
  input: z.string().min(1),
});

export const DeterministicScenarioSchema = BaseScenario.extend({
  type: z.literal('deterministic'),
  match: z.enum(['contains', 'exact', 'regex']),
  expected: z.string().min(1),
});

export const SemanticScenarioSchema = BaseScenario.extend({
  type: z.literal('semantic'),
  expectedSimilarTo: z.string().min(1),
  minSimilarity: z.number().min(0).max(1).default(0.75),
});

export const LlmJudgeScenarioSchema = BaseScenario.extend({
  type: z.literal('llm-judge'),
  rubric: z.string().min(1),
  minScore: z.number().min(0).max(10).default(7),
});

export const HumanScenarioSchema = BaseScenario.extend({
  type: z.literal('human'),
  rubric: z.string().min(1),
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
});

export const ScenarioSchema = z.discriminatedUnion('type', [
  DeterministicScenarioSchema,
  SemanticScenarioSchema,
  LlmJudgeScenarioSchema,
  HumanScenarioSchema,
]);

export const SuiteSchema = z.object({
  suite: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1),
    passingThreshold: z.number().min(0).max(1).optional(),
  }),
  scenarios: z.array(ScenarioSchema).min(1),
});
```

---

## Result Schemas

Results are the immutable record of a run. Two layers: a run (one suite execution) and
scenario results (one per scenario).

```typescript
export const EvalRunSchema = z.object({
  id: z.string(),
  suiteId: z.string(),
  model: z.string(),
  timestamp: z.string(),
  passed: z.boolean(),
  passRate: z.number(),
  totalScenarios: z.number().int(),
  passedScenarios: z.number().int(),
  totalLatencyMs: z.number(),
  estimatedCostUsd: z.number(),
});

// Per-type details — captures the reasoning needed to diagnose failures
const DeterministicDetails = z.object({
  type: z.literal('deterministic'),
  match: z.enum(['contains', 'exact', 'regex']),
  expected: z.string(),
  passed: z.boolean(),
});

const SemanticDetails = z.object({
  type: z.literal('semantic'),
  similarity: z.number(),
  threshold: z.number(),
});

const LlmJudgeDetails = z.object({
  type: z.literal('llm-judge'),
  score: z.number(),
  reasoning: z.string(),   // primary prompt-engineering signal
  judgeModel: z.string(),
  biasRisk: z.boolean(),   // true when judgeModel === model under evaluation
});

const HumanDetails = z.object({
  type: z.literal('human'),
  status: z.enum(['pending', 'approved', 'rejected']),
  reviewerNotes: z.string().optional(),
});

const ScenarioResultDetailsSchema = z.discriminatedUnion('type', [
  DeterministicDetails,
  SemanticDetails,
  LlmJudgeDetails,
  HumanDetails,
]);

export const ScenarioResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  scenarioId: z.string(),
  suiteId: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(1).nullable(),  // null for pending human evals
  actualOutput: z.string(),
  latencyMs: z.number(),
  estimatedCostUsd: z.number(),
  details: ScenarioResultDetailsSchema,
});
```

---

## Directory Structure

### Development (repository)

```
<project root>
├── lib/evaluations/         ← the library (schemas, runner, storage)
├── suites/                  ← bundled suite definitions (checked into git)
│   ├── wiki-search.yaml
│   └── agent-routing.yaml
└── eval-results/            ← generated run output (gitignored)
    ├── wiki-search-2026-07-15T12-00-00Z.yaml
    └── wiki-search-2026-07-15T14-30-00Z.yaml
```

### Production (user config directory)

```
~/.config/amazing-hashbrown/
├── config.yaml
├── database.db
├── wiki/
└── evals/
    ├── suites/              ← user-contributed suites
    └── results/             ← production run results
```

Bundled suites (in the repo) serve as the canonical, maintained test suite for the
application's own features. User suites allow operators and contributors to add domain-
specific scenarios without modifying the repository. A user suite contributed back via PR
becomes a bundled suite.

### Result file format

Result files mirror the YAML schema for human and agent readability. The `reasoning` field
on LLM-as-judge results is the key signal for prompt engineering iteration.

```yaml
run:
  id: "a3f2c1d4-..."
  suiteId: wiki-search
  model: ollama/llama3.2
  timestamp: "2026-07-15T12:00:00.000Z"
  passed: false
  passRate: 0.75
  totalScenarios: 4
  passedScenarios: 3
  totalLatencyMs: 4230
  estimatedCostUsd: 0.0012

results:
  - scenarioId: basic-provider-lookup
    passed: true
    score: 1.0
    actualOutput: "To configure a provider, navigate to Settings > Providers..."
    latencyMs: 342
    estimatedCostUsd: 0.0001
    details:
      type: deterministic
      match: contains
      expected: "provider"
      passed: true

  - scenarioId: conceptual-distinction
    passed: false
    score: 0.5
    actualOutput: "Skills and tools are both ways to extend the agent..."
    latencyMs: 1205
    estimatedCostUsd: 0.0004
    details:
      type: llm-judge
      score: 5
      reasoning: |
        The response treats skills and tools as equivalent extension mechanisms
        without distinguishing their fundamental difference: skills are
        prompt-driven while tools are function calls with side effects.
      judgeModel: claude-sonnet-4-6
```

---

## File Discovery and the Runner

### Suite Discovery

The loader collects YAML files from two directories, merges them, and validates each against
`SuiteSchema`. If the same `suite.id` appears in both paths, the user suite wins — this lets
users override a bundled suite without modifying the repo.

```typescript
interface SuiteLoaderConfig {
  bundledPath: string;   // e.g. <project-root>/suites/
  userPath?: string;     // e.g. ~/.config/amazing-hashbrown/evals/suites/
}

async function loadSuites(config: SuiteLoaderConfig): Promise<Map<string, Suite>>
```

Discovery order: glob `**/*.yaml` in `bundledPath`, parse and index by `suite.id`, then
repeat for `userPath` — later entries overwrite earlier ones. Any file that fails
`SuiteSchema.parse()` logs a validation error and is skipped rather than crashing the run.

### Runner Interface

The runner is model-agnostic: it accepts a LangChain `BaseChatModel` so any configured
provider works without changes to the eval logic. The judge model for LLM-as-judge scenarios
must be provided explicitly — using the same model as judge introduces a conflict of interest
(the model scores its own output) which is flagged via `biasRisk: true` in the result details.

```typescript
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

interface RunConfig {
  suiteId?: string;           // omit to run all discovered suites
  model: BaseChatModel;       // the model under evaluation
  modelId: string;            // human-readable identifier stored in results, e.g. "ollama/llama3.2"
  judgeModel: BaseChatModel;  // for llm-judge scenarios; must be explicit
  judgeModelId: string;       // human-readable identifier for the judge
  suitePaths: SuiteLoaderConfig;
  resultPath: string;         // directory to write YAML result files
}

async function runEval(config: RunConfig): Promise<EvalRun>
```

### Execution per Scenario Type

| Type | Execution |
|---|---|
| `deterministic` | Invoke `model` with `input` → apply `match` predicate against `expected` |
| `semantic` | Invoke `model` with `input` → embed output and `expectedSimilarTo` → cosine similarity |
| `llm-judge` | Invoke `model` with `input` → invoke `judgeModel` with output + `rubric` → structured verdict |
| `human` | No model call — record `status` from the YAML file; score is `null` if pending |

Human scenarios that are `pending` are included in results but excluded from the pass rate
calculation — they neither pass nor fail until reviewed.

### Judge Model Structured Output

The LLM-as-judge call uses a structured output schema so the verdict is always parseable:

```typescript
const JudgeVerdictSchema = z.object({
  score: z.number().min(0).max(10),
  reasoning: z.string(),
  passed: z.boolean(),
});
```

### Dual-Write on Completion

Once all scenarios complete, the runner writes results to both sinks from the same in-memory
`EvalRun` object:

```
runEval()
  └─ executeScenarios() → EvalRun (in memory)
       ├─ writeToSqlite(run)    → eval_runs + eval_results tables
       └─ writeToYaml(run)      → <resultPath>/<suiteId>-<timestamp>.yaml
```

If either write fails, the error is surfaced but the other write is not rolled back — a
partial result on disk is better than no result at all.

---

## SQLite Storage

### Tables

```sql
CREATE TABLE IF NOT EXISTS eval_runs (
  run_id              TEXT PRIMARY KEY,
  suite_id            TEXT NOT NULL,
  model               TEXT NOT NULL,
  judge_model         TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  passed              INTEGER NOT NULL,
  pass_rate           REAL NOT NULL,
  total_scenarios     INTEGER NOT NULL,
  passed_scenarios    INTEGER NOT NULL,
  total_latency_ms    INTEGER NOT NULL,
  estimated_cost_usd  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_results (
  result_id           TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES eval_runs(run_id),
  scenario_id         TEXT NOT NULL,
  suite_id            TEXT NOT NULL,
  type                TEXT NOT NULL,
  passed              INTEGER NOT NULL,
  score               REAL,
  actual_output       TEXT NOT NULL,
  latency_ms          INTEGER NOT NULL,
  estimated_cost_usd  REAL NOT NULL,
  details             TEXT NOT NULL CHECK(json_valid(details))
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run    ON eval_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_suite     ON eval_runs(suite_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_started   ON eval_runs(started_at);
```

`details` is stored as JSON TEXT. `CHECK(json_valid(details))` provides DB-level validation
as a safety net on top of Zod. The `type` column is stored separately so the read path can
filter by eval type without parsing JSON — SQLite's `json_extract()` is available if needed
for deeper queries but not required by the core read API.

### JSON Serialization Boundary

SQLite has no native JSON column type. The `details` field is `JSON.stringify`'d on write and
parsed on read. Zod handles the read side via a transform helper:

```typescript
const JsonOf = <T extends z.ZodType>(schema: T) =>
  z.string().transform((str, ctx) => {
    try {
      return schema.parse(JSON.parse(str));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid JSON in details column' });
      return z.NEVER;
    }
  });
```

This is used in the SQLite row schema to parse and validate `details` in a single step. The
write path calls `JSON.stringify(result.details)` directly before insert.

### Store Interface

`EvaluationsStore` extends `BaseStore` and follows the same boot/singleton pattern as
`ObservabilityStore`:

```typescript
class EvaluationsStore extends BaseStore {
  saveRun(run: EvalRun, results: ScenarioResult[]): void  // single transaction

  findRunById(runId: string): EvalRun | null
  findRuns(filters?: EvalRunFilters): EvalRun[]
  findResultsByRunId(runId: string): ScenarioResult[]
}

interface EvalRunFilters {
  suiteId?: string;
  model?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export function bootEvaluations(db: Database): void
export function getEvaluationsStore(): EvaluationsStore
```

`saveRun` wraps both inserts in a single `db.transaction`. In `api/src/index.ts`:

```typescript
const db = openDatabase(env.database.path);
bootObservability(db);
bootUsage(db);
bootEvaluations(db);
```

---

## Open Design Questions

The following sections are still being designed:

- **CLI interface** — `npm run eval` flags, output format, exit codes
- **Supporting mechanics** — golden path authoring, failure-to-eval, bug-to-eval workflows
