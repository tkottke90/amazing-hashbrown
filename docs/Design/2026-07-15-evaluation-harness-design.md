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

## CLI Interface

The CLI is an npm script that calls the evaluations library directly. It is the primary
developer and CI interface for running suites.

### Commands

```bash
# Run a specific suite
npm run eval -- --suite wiki-search --model ollama/llama3.2

# Run all suites
npm run eval -- --model ollama/llama3.2

# Specify an explicit judge model (required when llm-judge scenarios are present)
npm run eval -- --suite wiki-search --model ollama/llama3.2 --judge-model anthropic/claude-haiku-4-5

# CI mode — human evals skipped, not scored, not counted in pass rate
npm run eval -- --suite wiki-search --model ollama/llama3.2 --ci

# Review pending human evals from a previous run (deferred scoring)
npm run eval:review -- --run <runId>
```

`eval:review` supports the "come back and wrap up" workflow: the model runs and saves human
eval outputs as `pending`, and the reviewer scores them separately without re-running the
full suite.

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | Suite passed (pass rate met threshold) |
| `1` | Suite failed (pass rate below threshold) |
| `2` | Configuration error (bad flags, missing suite, invalid YAML) |
| `3` | Runtime error (model unreachable, DB write failed) |

Exit code `1` is what makes `npm run eval` useful as a CI gate.

### Terminal Output

**Normal mode** (automated evals run, TUI launches for pending human evals):

```
Running suite: wiki-search (4 scenarios) against ollama/llama3.2

  ✓  basic-provider-lookup        deterministic   342ms
  ✗  conceptual-distinction       llm-judge      1205ms   score: 5/10
  ✓  summary-quality              semantic        890ms   similarity: 0.81
  ◌  tone-empathy-check           human           —       pending review

Results: 2/3 evaluated passed  (1 pending)   pass rate: 0.67   threshold: 0.80
Status: FAIL

Failure details:
  conceptual-distinction
    Score: 5/10  [biasRisk: false]
    Reasoning: The response treats skills and tools as equivalent extension
    mechanisms without distinguishing their fundamental difference...

Result written to: eval-results/wiki-search-2026-07-15T12-00-00Z.yaml
```

**CI mode** (`--ci` — human evals are skipped entirely, no model call, not counted):

```
Running suite: wiki-search (4 scenarios) against ollama/llama3.2  [--ci]

  ✓  basic-provider-lookup        deterministic   342ms
  ✗  conceptual-distinction       llm-judge      1205ms   score: 5/10
  ✓  summary-quality              semantic        890ms   similarity: 0.81
  ⊘  tone-empathy-check           human           —       skipped

Results: 2/3 automated passed  (1 human skipped)   pass rate: 0.67   threshold: 0.80
Status: FAIL
```

`pending` means the model ran and output exists but no score yet. `skipped` means nothing
ran at all. Only automated scenarios contribute to the pass rate in CI mode.

### Human Eval TUI

When human eval scenarios are present and `--ci` is not set, the CLI launches an interactive
scoring session after the automated scenarios complete.

```
Human Scoring — 2 of 5
────────────────────────────────────────

Input:
  Something went wrong and I don't know why

Output:
  I'm sorry to hear that. Let's work through this together.
  First, can you tell me which feature you were using when
  the error occurred?

────────────────────────────────────────
Rubric:
  Response should be empathetic, offer a clear explanation,
  and suggest concrete next steps.
────────────────────────────────────────

[Y] Yes    [N] No

> _
```

After selection:

```
Notes (optional — press Enter to skip):
> _
```

Then immediately advances to the next pending scenario. When all are scored, results are
written and the summary is printed.

### Human Eval Scoring Types

The `scoring` field on a human scenario configures what the reviewer sees. Two types:

**Choice** (binary or multiple option — key + label, each marked as passing or not):

```yaml
scoring:
  type: choice
  options:
    - key: "Y"
      label: "Yes"
      pass: true
    - key: "N"
      label: "No"
      pass: false
```

**Scale** (numeric range with labels — passes if selected value meets `passingScore`):

```yaml
scoring:
  type: scale
  options:
    - value: 1
      label: "Bad"
    - value: 2
      label: "Okay"
    - value: 3
      label: "Good"
    - value: 4
      label: "Great"
  passingScore: 3
```

Zod schemas:

```typescript
const ChoiceOption = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  pass: z.boolean(),
});

const ScaleOption = z.object({
  value: z.number(),
  label: z.string().min(1),
});

const ScoringSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), options: z.array(ChoiceOption).min(2) }),
  z.object({ type: z.literal('scale'), options: z.array(ScaleOption).min(2), passingScore: z.number() }),
]);

export const HumanScenarioSchema = BaseScenario.extend({
  type: z.literal('human'),
  rubric: z.string().min(1),
  scoring: ScoringSchema,
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
});
```

`HumanDetails` in results stores the reviewer's response and any notes:

```typescript
const HumanDetails = z.object({
  type: z.literal('human'),
  status: z.enum(['pending', 'approved', 'rejected', 'skipped']),
  response: z.string().optional(),       // key or value selected by reviewer
  reviewerNotes: z.string().optional(),
});
```

Skipped human evals (CI mode) get `actualOutput: ''`, `score: null`, `latencyMs: 0`.

---

## Supporting Mechanics

Three workflows that allow the eval suite to grow organically alongside the application.
Anywhere an interactive TUI is used, a `-d|--detached` flag provides a file-based alternative
for coding agents, which cannot interact with TUIs.

---

### Golden Path Authoring — `eval:new`

The entry point for EDD. Before implementing a feature, run:

```bash
# Interactive (human)
npm run eval:new -- --suite wiki-search

# Detached (agent)
npm run eval:new -- --suite wiki-search --detached
```

**Interactive mode** launches a step-by-step prompt, then appends the completed scenario to
the suite file.

**Detached mode** appends a skeleton scenario with `TODO` markers and prints the file path:

```yaml
- id: TODO-scenario-id
  name: TODO - Scenario name
  purpose: TODO - Why does this scenario matter?
  type: deterministic   # change to: deterministic | semantic | llm-judge | human
  input: TODO - Input sent to the model
  match: contains       # contains | exact | regex
  expected: TODO - Expected value
```

The `purpose` prompt is deliberate: "why does this scenario matter?" forces the author to
articulate value before writing the test — the EDD discipline in practice.

---

### Failure-to-Eval — `eval:from-trace`

When a bad response is observed in the app, grab the trace ID from the observability output
and run:

```bash
# Interactive (human)
npm run eval:from-trace -- --trace-id <id> --suite wiki-search

# Detached (agent)
npm run eval:from-trace -- --trace-id <id> --suite wiki-search --detached
```

**Interactive mode** pulls the trace from SQLite, displays the input and output, then prompts
for what went wrong and the eval type.

**Detached mode** pre-fills `input` from the trace and leaves eval-specific fields as TODOs:

```yaml
- id: TODO-change-me
  name: TODO - Scenario name
  purpose: "Regression: captured from trace a3f2c1d4-..."
  type: llm-judge       # TODO: confirm eval type
  input: "What is the difference between a skill and a tool?"
  rubric: TODO - What should the correct response look like?
  minScore: 7
```

The `purpose` defaults to `Regression: captured from trace <id>` as a starting point the
developer makes meaningful before committing.

---

### Bug-to-Eval — Convention, Not a Command

Turning a GitHub issue into an eval is a **developer discipline** documented in `AGENTS.md`,
not a CLI feature. The convention:

1. When an issue is filed, write a failing eval **before** writing the fix.
2. Use the issue number in the scenario ID: `issue-42-provider-config-parsing`.
3. Use the issue title as `name`; issue description as the starting point for `purpose`.
4. The eval passes when the bug is fixed — it is the acceptance criterion for the PR.

> **The eval is the fix spec. A PR that closes an issue should include a scenario that
> would have caught it.**

This gets documented in `AGENTS.md` alongside EDD guidance so both human developers and
coding agents follow it consistently.

---

### Human Eval Deferred Scoring — `eval:review` and `eval:submit`

Human eval outputs are saved as `pending` after the model run. Scoring can happen
immediately (TUI launches after automated evals) or deferred to a separate session.

```bash
# Interactive review of a previous run (human)
npm run eval:review -- --run <runId>

# Detached — write a review manifest for agent to fill in
npm run eval:review -- --run <runId> --detached
# → Wrote: eval-results/review-<runId>.yaml

# Submit a completed manifest
npm run eval:submit -- --review-file eval-results/review-<runId>.yaml
```

The manifest pre-fills model output for context; the agent fills in `response` and
`reviewerNotes`:

```yaml
runId: a3f2c1d4-...
reviews:
  - scenarioId: tone-empathy-check
    input: "Something went wrong and I don't know why"
    actualOutput: "I'm sorry to hear that. Let's work through this together..."
    rubric: Response should be empathetic and suggest next steps.
    scoring:
      type: choice
      options:
        - key: "Y"
          label: "Yes"
          pass: true
        - key: "N"
          label: "No"
          pass: false
    response: ""        # fill in: "Y" or "N"
    reviewerNotes: ""   # optional notes
```

---

## Library API

`lib/evaluations` is the shared core. CLI scripts in `bin/` and future API routes are thin
consumers of this library. The package is structured as follows:

```
lib/evaluations/
├── src/
│   ├── index.ts          ← public exports
│   ├── schemas.ts        ← all Zod schemas and inferred types
│   ├── loader.ts         ← loadSuites(), loadSuite()
│   ├── runner.ts         ← runEval()
│   ├── comparator.ts     ← compareRuns()
│   ├── executors/
│   │   ├── deterministic.ts
│   │   ├── semantic.ts
│   │   ├── llm-judge.ts
│   │   └── human.ts
│   ├── store.ts          ← EvaluationsStore, bootEvaluations(), getEvaluationsStore()
│   └── serializer.ts     ← YAML, HTML, and review manifest I/O
└── templates/
    ├── result.njk         ← single run HTML report (Nunjucks)
    ├── comparison.njk     ← comparison HTML report (Nunjucks)
    └── partials/
        ├── scenario-row.njk
        └── suite-summary.njk
```

CLI entry points live outside the library in `bin/` at the project root, wired as npm
scripts. Each script is thin: parse args, build config, call the library.

```
bin/
├── eval.ts              ← npm run eval
├── eval-new.ts          ← npm run eval:new
├── eval-from-trace.ts   ← npm run eval:from-trace
├── eval-review.ts       ← npm run eval:review
├── eval-submit.ts       ← npm run eval:submit
└── eval-compare.ts      ← npm run eval:compare
```

Root `package.json` scripts:

```json
{
  "scripts": {
    "eval":            "tsx bin/eval.ts",
    "eval:new":        "tsx bin/eval-new.ts",
    "eval:from-trace": "tsx bin/eval-from-trace.ts",
    "eval:review":     "tsx bin/eval-review.ts",
    "eval:submit":     "tsx bin/eval-submit.ts",
    "eval:compare":    "tsx bin/eval-compare.ts"
  }
}
```

---

### `loader.ts`

```typescript
interface SuiteLoaderConfig {
  bundledPath: string;   // absolute path to bundled suites directory
  userPath?: string;     // absolute path to user suites directory
}

// Discovers all *.yaml files in both paths, validates each against SuiteSchema.
// If the same suite.id appears in both, userPath wins.
// Files that fail validation are skipped with a logged warning — never throws.
async function loadSuites(config: SuiteLoaderConfig): Promise<Map<string, Suite>>

// Convenience wrapper — loads a single suite by id, returns null if not found.
async function loadSuite(id: string, config: SuiteLoaderConfig): Promise<Suite | null>
```

---

### `runner.ts`

```typescript
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';

interface RunConfig {
  suiteId?: string;            // omit to run all discovered suites
  model: BaseChatModel;        // model under evaluation
  modelId: string;             // stored in results, e.g. "ollama/llama3.2"
  judgeModel: BaseChatModel;   // required — no same-model fallback
  judgeModelId: string;        // stored in results
  embeddings?: Embeddings;     // required if any semantic scenarios are present
  suitePaths: SuiteLoaderConfig;
  resultPath: string;          // directory where result files are written
  ci?: boolean;                // skips human evals when true; default false
  noHtml?: boolean;            // suppresses HTML report generation; default false
  store?: EvaluationsStore;    // if provided, saves results to SQLite
}

interface RunResult {
  run: EvalRun;
  results: ScenarioResult[];
  yamlPath: string;            // absolute path to the written result YAML
  htmlPath?: string;           // absolute path to the written HTML report (absent when noHtml: true)
}

// Loads suites, executes all scenarios, writes results to YAML and optionally SQLite.
// Never throws on scenario failure — errors are captured per-scenario in details.
async function runEval(config: RunConfig): Promise<RunResult>
```

`store` is optional: when the database is unavailable (fresh environment, first run before
the app has booted), the CLI logs a warning and falls back to YAML-only output. In
production, the server opens a `better-sqlite3` connection and passes it to
`bootEvaluations(db)`. CLI scripts open their own independent connection to the same SQLite
file — SQLite WAL mode handles concurrent access safely.

---

### `executors/` (internal)

Executors are not exported. Each takes a scenario and returns a `ScenarioResult`. They never
throw — model errors are caught and recorded as a failed result with error detail.

```typescript
async function executeDeterministic(
  scenario: DeterministicScenario,
  model: BaseChatModel,
  runId: string,
): Promise<ScenarioResult>

async function executeSemantic(
  scenario: SemanticScenario,
  model: BaseChatModel,
  embeddings: Embeddings,
  runId: string,
): Promise<ScenarioResult>

async function executeLlmJudge(
  scenario: LlmJudgeScenario,
  model: BaseChatModel,
  modelId: string,
  judgeModel: BaseChatModel,
  judgeModelId: string,
  runId: string,
): Promise<ScenarioResult>

// Synchronous — no model call.
// ci=true → status: 'skipped', actualOutput: '', score: null, latencyMs: 0
// ci=false → status: 'pending', model runs to generate actualOutput
function executeHuman(
  scenario: HumanScenario,
  runId: string,
  ci: boolean,
): ScenarioResult
```

---

### `store.ts`

```typescript
interface EvalRunFilters {
  suiteId?: string;
  model?: string;
  since?: string;    // ISO 8601 — returns runs started after this timestamp
  limit?: number;
  offset?: number;
}

interface HumanResultUpdate {
  status: 'approved' | 'rejected';
  response: string;          // key or value selected by the reviewer
  reviewerNotes?: string;
}

class EvaluationsStore extends BaseStore {
  // Inserts run + all results in a single transaction.
  saveRun(run: EvalRun, results: ScenarioResult[]): void

  // Updates a single human eval result after scoring (used by eval:submit).
  updateHumanResult(resultId: string, update: HumanResultUpdate): void

  findRunById(runId: string): EvalRun | null
  findRuns(filters?: EvalRunFilters): EvalRun[]
  findResultsByRunId(runId: string): ScenarioResult[]

  // Returns only results where human status is 'pending' — used by eval:review.
  findPendingHumanResults(runId: string): ScenarioResult[]
}

export function bootEvaluations(db: Database): void
export function getEvaluationsStore(): EvaluationsStore
```

---

### `serializer.ts`

```typescript
// Writes a result YAML file named <suiteId>-<timestamp>.yaml.
// Returns the absolute path of the written file.
async function writeResultYaml(
  run: EvalRun,
  results: ScenarioResult[],
  resultPath: string,
): Promise<string>

// Parses a result YAML file back into typed, validated objects.
async function readResultYaml(filePath: string): Promise<{
  run: EvalRun;
  results: ScenarioResult[];
}>

// Writes a review manifest for pending human evals (eval:review --detached).
// Returns the absolute path of the written manifest file.
async function writeReviewManifest(
  run: EvalRun,
  pendingResults: ScenarioResult[],
  suites: Map<string, Suite>,
  resultPath: string,
): Promise<string>

// Parses a completed review manifest (eval:submit).
async function readReviewManifest(filePath: string): Promise<ReviewManifest>

// Renders a single run report to HTML using Nunjucks (result.njk).
// Filename: <suiteId>-<timestamp>.html — same base name as the YAML result.
// Returns the absolute path of the written file.
async function writeResultHtml(
  run: EvalRun,
  results: ScenarioResult[],
  resultPath: string,
): Promise<string>

// Renders a comparison report to HTML using Nunjucks (comparison.njk).
// Filename: comparison-<runAId>-vs-<runBId>.html
// Returns the absolute path of the written file.
async function writeComparisonHtml(
  comparison: ComparisonResult,
  resultPath: string,
): Promise<string>

interface ReviewManifest {
  runId: string;
  reviews: ReviewEntry[];
}

interface ReviewEntry {
  resultId: string;          // links back to the ScenarioResult row in SQLite
  scenarioId: string;
  input: string;
  actualOutput: string;
  rubric: string;
  scoring: z.infer<typeof ScoringSchema>;
  response: string;          // filled in by reviewer
  reviewerNotes: string;     // filled in by reviewer
}
```

---

### Public exports (`index.ts`)

```typescript
// Schemas
export { SuiteSchema, ScenarioSchema, EvalRunSchema, ScenarioResultSchema }
export { DeterministicScenarioSchema, SemanticScenarioSchema,
         LlmJudgeScenarioSchema, HumanScenarioSchema, ScoringSchema }

// Types
export type { Suite, Scenario, EvalRun, ScenarioResult }
export type { DeterministicScenario, SemanticScenario,
              LlmJudgeScenario, HumanScenario }
export type { RunConfig, RunResult, SuiteLoaderConfig,
              EvalRunFilters, HumanResultUpdate,
              ReviewManifest, ReviewEntry }

// Suite loading
export { loadSuites, loadSuite }

// Runner
export { runEval }

// Storage
export { bootEvaluations, getEvaluationsStore, EvaluationsStore }

// Result I/O
export { writeResultYaml, readResultYaml,
         writeResultHtml, writeComparisonHtml,
         writeReviewManifest, readReviewManifest }

// Comparison
export { compareRuns }
export type { ComparisonResult, ScenarioComparison }
```

---

## HTML Reporting

HTML reports are generated by default alongside YAML result files. Suppress with `--no-html`
when HTML output is not needed (e.g. a minimal CI pipeline).

```bash
# Default — generates YAML and HTML
npm run eval -- --suite wiki-search --model ollama/llama3.2

# Suppress HTML
npm run eval -- --suite wiki-search --model ollama/llama3.2 --no-html
```

Output files share the same base name:

```
eval-results/
├── wiki-search-2026-07-15T12-00-00Z.yaml
└── wiki-search-2026-07-15T12-00-00Z.html
```

### Templating

HTML is rendered using [Nunjucks](https://mozilla.github.io/nunjucks/) — a Jinja2-style
templating library with full async support and strong TypeScript types. Templates live inside
the library under `lib/evaluations/templates/` and are bundled with the package.

```
lib/evaluations/templates/
├── base.css           ← shared styles across all reports
├── result.njk         ← single run report
├── comparison.njk     ← comparison report
└── partials/
    ├── scenario-row.njk
    └── suite-summary.njk
```

Reports are fully self-contained: all CSS is inlined, no external CDN dependencies, readable
offline. The report renders correctly in both light and dark browser themes.

### CSS Strategy

`base.css` is a plain CSS file — not a Nunjucks template — so it benefits from full editor
syntax highlighting and can be maintained without Nunjucks escaping concerns. The serializer
reads it as a string at render time and passes it to templates as a variable:

```typescript
// In serializer.ts
const styles = await fs.readFile(
  path.join(TEMPLATES_DIR, 'base.css'), 'utf-8'
);

nunjucks.render('result.njk', { run, results, styles });
nunjucks.render('comparison.njk', { comparison, styles });
```

Templates inline it via Nunjucks's `safe` filter, which suppresses escaping:

```nunjucks
<style>
  {{ styles | safe }}
</style>
```

This produces a single self-contained HTML file with all styles inlined, while keeping CSS
authoring in a proper `.css` file — one place to update when the visual design changes,
shared across all report types.

### Single Run Report Content

- Suite summary: name, model, judge model, timestamp, pass rate, threshold, total cost, total latency
- Per-scenario table: status icon, name, type, latency, score
- Expandable failure detail: `actualOutput` and type-specific reasoning (most valuable for
  LLM-as-judge `reasoning` during prompt engineering iteration)
- `biasRisk: true` flagged visually when judge model matches model under evaluation

---

## Session Comparisons

A comparison takes two eval runs on the same suite and produces a structured diff —
highlighting which scenarios improved, regressed, or stayed the same between runs.

Primary use cases:

- **EDD progress:** same suite, same model, two points in time — tracks which scenarios
  moved from fail to pass as a feature is implemented
- **Model comparison:** same suite, two different models — shows relative performance,
  cost, and latency differences side by side
- **Regression detection:** before/after a prompt change on the same model

### `comparator.ts`

```typescript
interface ScenarioComparison {
  scenarioId: string;
  name: string;
  type: Scenario['type'];
  runA: Pick<ScenarioResult, 'passed' | 'score' | 'latencyMs' | 'estimatedCostUsd' | 'details'> | null;
  runB: Pick<ScenarioResult, 'passed' | 'score' | 'latencyMs' | 'estimatedCostUsd' | 'details'> | null;
  // null entries indicate a scenario present in one run but not the other
  change: 'pass→pass' | 'pass→fail' | 'fail→pass' | 'fail→fail' | 'pending' | 'added' | 'removed';
}

interface ComparisonResult {
  suiteId: string;
  runA: EvalRun;
  runB: EvalRun;
  scenarios: ScenarioComparison[];
  summary: {
    improved: number;    // fail→pass
    regressed: number;   // pass→fail
    unchanged: number;   // same result in both runs
    added: number;       // scenarios in runB not present in runA
    removed: number;     // scenarios in runA not present in runB
  };
}

// Pure function — no I/O. Takes two fully-loaded runs and produces a diff.
function compareRuns(
  runA: EvalRun,
  resultsA: ScenarioResult[],
  runB: EvalRun,
  resultsB: ScenarioResult[],
): ComparisonResult
```

### CLI — `eval:compare`

```bash
# Compare two specific runs by ID (loads from SQLite)
npm run eval:compare -- --run-a <runId> --run-b <runId>

# Convenience: compare the last two runs of a suite
npm run eval:compare -- --suite wiki-search --last 2

# Model comparison: run the suite twice then compare
npm run eval:compare -- --suite wiki-search \
  --model-a ollama/llama3.2 \
  --model-b anthropic/claude-haiku-4-5
```

The `--model-a / --model-b` form runs the suite against both models internally and feeds the
results directly to `compareRuns()` — no manual run-ID lookup required for the common model
comparison case.

Output is always written as an HTML file:

```
eval-results/comparison-<runAId>-vs-<runBId>.html
```

### Comparison Report Content

The HTML comparison report renders a side-by-side table with one row per scenario:

| Scenario | Change | Run A score | Run B score | Δ score | Δ latency | Δ cost |
|---|---|---|---|---|---|---|
| basic-provider-lookup | pass→pass | 1.0 | 1.0 | — | −42ms | −$0.00002 |
| conceptual-distinction | fail→pass | 0.5 | 0.8 | +0.3 | +210ms | +$0.0001 |
| summary-quality | pass→pass | 0.81 | 0.92 | +0.11 | −80ms | −$0.00005 |

- Regressions (`pass→fail`) are highlighted red
- Improvements (`fail→pass`) are highlighted green
- Expandable rows show the LLM-as-judge `reasoning` from both runs for direct comparison
- Summary bar at the top: improved / regressed / unchanged counts and aggregate Δ cost
