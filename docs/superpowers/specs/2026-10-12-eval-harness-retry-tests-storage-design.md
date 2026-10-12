# Eval harness hardening: target-model retry/timeout, executor unit tests, richer result storage

**Issue:** [tkottke90/amazing-hashbrown#289](https://github.com/tkottke90/amazing-hashbrown/issues/289)
**Parent epic:** [tkottke90/amazing-hashbrown#270](https://github.com/tkottke90/amazing-hashbrown/issues/270)
**Date:** 2026-10-12

## Background

Issue #270's "Harness hardening" roadmap listed seven P2 items; only two were ever
opened and completed (#272, #273). A post-closure review found three items that were
never implemented, verified directly against `origin/main` and documented in
`docs/Design/2026-10-06-eval-system-reliability-audit.md` §2.2–§2.7:

1. The target model under test has no retry or timeout protection in
   `lib/evaluations/src/runner.ts`, unlike the judge model, which already wraps its
   structured-output call in `.withRetry({ stopAfterAttempt: 3 })`
   (`executors/llm-judge.ts:66`).
2. `executors/llm-judge.ts` and `executors/semantic.ts` have no adjacent unit test
   file, unlike every other executor.
3. Result storage (`schemas.ts`, `serializer.ts`) has no per-scenario timestamp,
   retry-attempt count, or raw request/response capture — weakening after-the-fact
   diagnosis of flaky runs.

This issue is independent of #271–#276 (already merged) and catches up on dropped
scope rather than being blocked by anything.

## Scope

In scope:

- Retry + timeout wrapper applied to **all three** target-model invocation paths in
  `runner.ts`: `invokeModel`, `invokeStructuredModel`, and `invokeToolCallModel`.
  (The issue names only the first two by line number; `invokeToolCallModel` has the
  identical gap and powers the tool-call/tool-sequence suites — the majority of this
  repo's suites — so it's included rather than left for a follow-up issue.)
- New unit test files for `executors/llm-judge.ts` and `executors/semantic.ts`.
- New per-scenario result fields: timestamp, retry-attempt count, raw transport
  snapshot — threaded through the Zod schema, the YAML serializer (no code change
  needed there), the SQLite store, and the HTML report.
- Bonus: regenerate the stale "Available Suites" table in
  `docs/App-Docs/Evaluations.md` (currently lists 9 of the 32 suites that exist
  under `suites/*.yaml`), called out separately in the PR description.

Out of scope:

- New CLI flags or `RunConfig` fields to make retry count / timeout configurable per
  run. Both are conservative hardcoded constants, matching how the judge's own
  retry is hardcoded today with no config knob.
- True wire-level HTTP capture (extending `DEBUG_LLM_HTTP`-style fetch hooks to the
  Ollama and Anthropic SDKs). The transport snapshot captures at the LangChain
  invoke boundary instead — see "Transport capture" below.
- Any change to judge-model retry behavior, which already works and isn't part of
  this issue's problem statement.

## Design

### 1. Resilience wrapper (`runner.ts`)

The issue's wording ("configurable the same way the judge model's is") suggests
reusing LangChain's `.withRetry()`, as the judge does. That's not viable here:
`.withRetry()` doesn't surface how many attempts it actually took, and this issue's
success criterion requires reporting a non-zero retry count per scenario. Instead,
`runner.ts` gets a small hand-rolled helper that provides the same automatic-recovery
behavior but makes the attempt count observable:

```ts
const TARGET_MODEL_MAX_ATTEMPTS = 2; // 1 initial + 1 retry
const TARGET_MODEL_TIMEOUT_MS = 600_000; // 10 minutes per attempt

interface ResilientInvokeResult<T> {
  result: T;
  attempts: number;
}

async function invokeWithResilience<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  maxAttempts = TARGET_MODEL_MAX_ATTEMPTS,
  timeoutMs = TARGET_MODEL_TIMEOUT_MS,
): Promise<ResilientInvokeResult<T>>;
```

- Each attempt gets its own `AbortController`; its `signal` is passed into the
  model call (e.g. `model.invoke(input, { signal })`), which LangChain's
  `RunnableConfig` supports uniformly across all three provider integrations even
  where the underlying SDK has no first-class timeout option (the known Ollama gap
  documented in `provider-factory.ts`'s inline comment).
- A `setTimeout` aborts that attempt's controller at `timeoutMs`; cleared on
  completion either way.
- On failure (thrown error, including an abort), the attempt counter increments and
  it retries up to `maxAttempts`. The final failed attempt's error is rethrown
  unchanged, preserving `executeScenario`'s existing `catch` block, which scores an
  exhausted scenario a hard `0` — this work makes that path less likely to trigger
  on transient failures, not different when it does.

**10-minute-per-attempt timeout, not "time to first token."** All three target-model
call sites (`invoke`, `withStructuredOutput().invoke()`, `bindTools().invoke()`) are
blocking, non-streaming calls — the harness never sees a partial response, so the
timeout is unavoidably "time to finish," not "time to first byte." Given that, and
given this repo has no existing timeout precedent to anchor on (`ProviderConfig.timeoutMs`
is optional with no default, and almost nothing sets it today), the timeout is sized
as last-resort hang protection rather than a normal latency bound: generous enough to
never cut off a slow-but-healthy generation (a thinking model's long
`reasoning_content` chain, a cold local Ollama/Lemonade start on modest hardware) —
users on low-power local setups already expect longer turnaround. With the 2-attempt
retry, a single scenario can take up to ~20 minutes before being scored a hard
failure; acceptable for an offline eval run.

**Call sites updated** — each now returns `attempts` alongside its existing return
value:

- `invokeModel` → wraps `model.invoke(input, { signal })`
- `invokeStructuredModel` → wraps `model.withStructuredOutput(outputSchema).invoke(input, { signal })`
- `invokeToolCallModel` → wraps `model.bindTools(tools).invoke(input, { signal })`

`latencyMs` keeps its current meaning (wall time for the whole call, retries
included) — measured outside the helper, same as today.

### 2. Executor unit tests

Two new files under `lib/evaluations/test/unit/executors/`, following the existing
pattern (`deterministic.test.ts`, `structured.test.ts`, `tool-call.test.ts`,
`tool-sequence.test.ts` — Mocha + Chai, stubbed dependencies, no live network calls,
`[unit]` tag per root `AGENTS.md`).

**`llm-judge.test.ts`** — stubs a `BaseChatModel`-shaped judge model whose
`withStructuredOutput().withRetry().invoke()` chain is a sinon stub:

- Prompt construction: input/rubric/actualOutput appear in the prompt sent to the
  judge; the `toolCalls` section is included only when passed and non-empty (the
  source has an explicit comment that omitting it must leave the prompt
  byte-for-byte identical to before that parameter existed — worth pinning with a
  regression test).
- Returned `LlmJudgeDetails` shape: `score`/`reasoning` pass through unchanged,
  `judgeModel` equals `judgeModelId`, `biasRisk` is `true` iff
  `judgeModelId === modelId`.
- Error path: when the judge's structured-output call throws (simulating retry
  exhaustion), `runLlmJudge` throws a wrapped error naming the judge model id.

**`semantic.test.ts`** — stubs an `Embeddings`-shaped object's `embedQuery`:

- `embedQuery` is called once for `actualOutput` and once for
  `scenario.expectedSimilarTo`.
- Cosine similarity math against known vectors: orthogonal → 0, identical → 1, and
  one hand-computed non-trivial case, plus the zero-vector/zero-length edge cases
  already explicitly handled in `cosineSimilarity`.
- `threshold` in the returned details equals `scenario.minSimilarity`, independent
  of the similarity result.

### 3. Richer result storage

**New fields on `ScenarioResultSchema`** (`schemas.ts`), top-level and
type-agnostic — siblings of the existing `latencyMs`/`estimatedCostUsd`, not nested
inside the per-scenario-type `details` union (these apply identically regardless of
scenario type, unlike e.g. judge `reasoning` or tool-call `calledTools`):

```ts
scenarioStartedAt: z.string().datetime().optional(),
retryAttempts: z.number().int().min(1).optional(),
transport: z
  .object({
    request: z.unknown(),
    response: z.unknown(),
  })
  .optional(),
```

All three `.optional()` so older on-disk YAML/SQLite results without them still
parse — the same convention already used for `scoredScenarios`/`systemPrompt`.

**Transport capture is a LangChain-level snapshot, not true wire-level HTTP
capture.** The three providers use different client libraries with no single
fetch-hook covering all of them (today's `DEBUG_LLM_HTTP` only wraps the
openai-type client). Rather than building per-SDK fetch hooks for Ollama and
Anthropic too, `transport.request`/`transport.response` capture the exact
serialized input (messages or string) sent to `.invoke()` and the raw response
object LangChain returns (content, tool_calls, response_metadata, usage, etc.) at
the invoke boundary in `runner.ts`. This works identically for all three provider
types with no per-SDK plumbing, one layer above the literal HTTP bytes. The
snapshot is captured in full on every scenario regardless of overlap with other
already-stored fields (e.g. tool-call's `responseMetadata`/`reasoningContent`,
every type's `actualOutput`) — simpler and uniform, and some duplication is an
acceptable cost for a debugging-only field.

**`runner.ts`**: `executeScenario` sets `scenarioStartedAt = new Date().toISOString()`
immediately before each scenario's model call(s); the three `invoke*Model` helpers
return the raw request/response pair and `attempts` alongside what they already
return, and every return branch in `executeScenario` attaches `retryAttempts`,
`transport`, and `scenarioStartedAt` to `baseResult`.

**`serializer.ts`**: no code change needed — `writeResultYaml` already serializes
whatever `ScenarioResultSchema` parses, so the new fields ride along automatically.

**`store.ts`**: `eval_results` gets three new nullable columns, via the same
`ALTER TABLE ... ADD COLUMN` migration pattern already used for
`system_prompt`/`scored_scenarios` on `eval_runs`:

```sql
ALTER TABLE eval_results ADD COLUMN scenario_started_at TEXT;
ALTER TABLE eval_results ADD COLUMN retry_attempts INTEGER;
ALTER TABLE eval_results ADD COLUMN transport TEXT; -- JSON-serialized
```

Read/write mapping follows the existing `camelCase ↔ snake_case` convention in that
file (e.g. `latencyMs ↔ latency_ms`).

**HTML report** (`result.njk`): add a collapsed, forensic-only disclosure per
scenario row (started-at, retry count, raw transport JSON) — keeps the main report
uncluttered while making the data reachable, matching the report's existing
per-scenario detail disclosure pattern.

### 4. Bonus: docs staleness fix

`docs/App-Docs/Evaluations.md`'s "Available Suites" table currently lists 9 suites;
`suites/*.yaml` actually has 32 files. Regenerate the table to list every current
suite file. Called out as a separate bullet in the PR description, not folded into
the "Expected Behavior" items, per the issue's explicit instruction (not part of
the original P2 roadmap wording).

## Testing strategy

- **Resilience wrapper**: extend `runner.test.ts` with a stubbed model whose
  `invoke` rejects N times then succeeds, asserting `attempts` is reported
  correctly; a timeout case uses a fake clock (sinon) rather than a real 10-minute
  wait, asserting the call is aborted and retried.
- **Executors**: as described above — `[unit]`-tagged, stubbed dependencies, no
  network calls.
- **Schema/storage**: `schemas.test.ts` gets cases for the three new optional
  fields (present, absent, old-data-missing-them still parses); `store.test.ts`
  gets a round-trip test for the new columns.
- **Measurable success criterion** (from the issue): a suite run against a provider
  stubbed to fail/hang on its first attempt completes successfully via retry rather
  than erroring the whole run, and the resulting result file shows a non-zero
  `retryAttempts` and a populated `transport` entry for that scenario. Covered by
  the `runner.test.ts` retry-then-succeed case above, exercised through
  `executeScenario`/`runEval` rather than only at the helper level, so the full
  write path (schema → YAML) is verified too.

## Error handling

Error handling is otherwise unchanged: a scenario that exhausts all retry attempts
still surfaces through `executeScenario`'s existing `catch` block and is scored a
hard `0` with `[scenario error] ...` as `actualOutput`. This work reduces how often
that path triggers on transient failures; it does not change what happens when it
still does.
