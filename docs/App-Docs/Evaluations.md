# Evaluations

The evaluation harness runs the chat agent's actual production system prompt and tool set
against a suite of scenarios (YAML files under `suites/`) to check whether a given model
behaves correctly — tool orchestration, response quality, and prompt-adherence. It exists
because prompt/model changes are otherwise only verified by hand; see
`docs/Design/agent-harness-evaluation-design.md` and
`docs/Design/2026-07-15-evaluation-harness-design.md` for the rationale and design history.

This document covers how to **run** evals. For how scenarios are authored (rubric writing,
scenario types, YAML shape), see `lib/evaluations/src/schemas.ts` — the zod schemas are the
authoritative reference — and the worked examples already under `suites/`.

## Prerequisites

1. **A working LLM provider must be configured** before running any eval — the harness invokes
   a real model, it does not mock one out. See [`Providers.md`](./Providers.md) for how to add
   one to `config/config.yaml`. Any provider type (`ollama`, `openai`, `anthropic`) works; local
   models via Ollama/Lemonade/LM Studio are the common case for cost-free iteration.
2. **Dependencies installed** (`npm install` at the repo root) — the eval CLI runs via `tsx`,
   no build step required.
3. **Embeddings configured** (`embeddings.enabled: true` in `config/config.yaml`, see
   [`configuration.md`](./configuration.md)) if you plan to run `semantic`-type scenarios —
   these score responses by embedding similarity. Suites that don't use `semantic` scenarios are
   unaffected if embeddings are disabled.
4. **SQLite is optional but recommended.** The harness always writes YAML (and by default HTML)
   result files regardless; it _additionally_ writes to the shared app database
   (`database.path` in config) when that database is reachable, which is what powers
   `bin/eval-calibrate.ts` (see below). If the database can't be opened, the run prints a
   warning and continues with YAML/HTML-only output — this is not a fatal error.

## Quick Start

```bash
# Run every suite under suites/
npm run eval -- --model local

# Run one suite
npm run eval -- --suite wiki-navigation --model local
```

`--model` is the only required flag — it must match a provider `name` from `config/config.yaml`,
not a raw model identifier (the provider entry's own `defaultModel` field supplies that — see
"Model vs. provider name" below).

## CLI Reference

All flags are passed after `--` to `npm run eval` (or directly to `tsx bin/eval.ts` if invoking
without npm). None are positional.

| Flag            | Type    | Required | Default           | Description                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--model`       | string  | **Yes**  | —                 | Provider `name` from `config/config.yaml` to run scenarios against (e.g. `local`). This is the model under test.                                                                                                                                                                                                                                             |
| `--suite`       | string  | No       | run every suite   | Suite id to run — the `suite.id` field inside a `suites/*.yaml` file, e.g. `wiki-navigation` (not the filename). Omit to discover and run every suite under `suites/`, alphabetically.                                                                                                                                                                       |
| `--judge-model` | string  | No       | same as `--model` | Provider `name` used to score `llm-judge`-type scenarios. Set this to a stronger/independent model to reduce judge bias — see `biasRisk` in results, which flags when judge and model-under-test are the same.                                                                                                                                               |
| `--ci`          | boolean | No       | `false`           | Skips `human`-type scenarios entirely (recorded as skipped, no interactive prompt) instead of running the interactive terminal review UI after the automated scenarios finish. Use this for non-interactive/CI runs.                                                                                                                                         |
| `--no-html`     | boolean | No       | `false`           | Skip generating the HTML report — only the YAML result file is written. Useful for fast iteration when you don't need the rendered report.                                                                                                                                                                                                                   |
| `--llm-review`  | boolean | No       | `false`           | After the run, spawns `claude -p` to produce a narrative review of the YAML/HTML results (which scenarios failed, whether each failure looks like a real product/model issue vs. an overly strict scenario). Requires the `claude` CLI on `PATH`; if it's missing or exits non-zero, this only prints a warning — it never affects the eval's own exit code. |

### Model vs. provider name

`--model`/`--judge-model` take a **provider name** (the `name` field of an entry in
`config/config.yaml`'s `providers[]` list), not a raw model id like `ornith-1.0-35b-Q4_K_M.gguf`
or `gpt-4.1-mini` — the actual model invoked is whichever one that provider entry's
`defaultModel` points to. There is no CLI flag to override the model for a single run; to test
multiple models, add multiple `providers[]` entries (distinct `name`, same or different
`baseUrl`/`type`, different `defaultModel`) and select between them with `--model <name>`.

### Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | All run suites passed (pass rate ≥ the suite's `passingThreshold`, default `1.0`).           |
| `1`  | At least one suite failed its passing threshold, but the run itself completed without error. |
| `2`  | Usage error — `--model` missing, the named provider/suite doesn't exist, or no suites found. |
| `3`  | Runtime error while running a single explicitly-named suite (`--suite` was given and threw). |

When `--suite` is omitted, a runtime error in one suite does **not** abort the batch — every
other suite still runs, and the run only exits non-zero at the end if any suite failed or
errored (printed in the final summary table with an `⚠ ERROR` row).

## Available Suites

| Suite id                | Scenarios | Purpose                                                                                                                                                                                                                                              |
| ----------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wiki-navigation`       | 12        | Chat agent correctly sequences `wiki_locate`/`wiki_orient`/`wiki_search`/`wiki_read_page` and recovers sensibly from ambiguous, no-match, and unknown-id cases.                                                                                      |
| `wiki-recall-quality`   | 3         | Final answers read as natural recall (not a wiki-internals status report) and don't fabricate steps beyond what's actually stored. Complements `wiki-navigation` — that suite tests tool sequencing, this one tests the resulting text quality.      |
| `wiki-search`           | 4         | Chat agent can search the knowledge base and return relevant, coherent, honest answers — the wiki-to-chat feature's acceptance criteria.                                                                                                             |
| `tool-calling`          | 2         | Chat agent actually invokes the correct built-in tool when a prompt calls for it, rather than just describing what it would do.                                                                                                                      |
| `instruction-hierarchy` | 3         | Adversarial user-supplied instructions (simulated hostile/malformed `AGENT.md` content) cannot override the harness's own tool-orchestration rules.                                                                                                  |
| `after-agent`           | 17        | AfterAgent Middleware's individual prompts (summarize/classify/extract/merge) behave correctly, tested directly against the same prompts the pipeline uses — **does not** attach the harness system prompt (see `appliesHarnessSystemPrompt` below). |
| `thread-titles`         | 7         | `POST /api/v1/threads/:id/generate-title` produces a short, accurate title — **does not** attach the harness system prompt.                                                                                                                          |

New suite files are auto-discovered by directory scan — dropping a new `suites/whatever.yaml`
file requires no registration anywhere.

### `appliesHarnessSystemPrompt`

Most suites implicitly test the live chat agent, so the harness attaches the real
`buildSystemPrompt()` output (identity/memory/wiki-navigation/ask-user-routing sections) before
invoking the model, matching production. A suite can opt out via
`suite.appliesHarnessSystemPrompt: false` in its YAML when its scenarios instead model a
_different_ production code path that never sees that prompt (`after-agent.yaml`,
`thread-titles.yaml` — see the comments in those files for why). Don't add this flag to a new
suite unless it has the same property: its `input` fields being the exact prompt of some other,
non-chat-agent code path.

## Scenario Types

Every scenario in a suite YAML has a `type` that determines how it's invoked and scored. Full
schemas live in `lib/evaluations/src/schemas.ts`; summary:

| Type            | Scoring                                                                                                                                                                                                       | Binds tools?   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `deterministic` | Exact/contains/regex match against expected text.                                                                                                                                                             | No             |
| `semantic`      | Embedding similarity against `expectedSimilarTo`, threshold `minSimilarity`. Needs embeddings enabled.                                                                                                        | No             |
| `llm-judge`     | A judge model scores the response 0–10 against a free-text `rubric`, threshold `minScore`. Can seed `priorTurns` (see below) to judge a response given prior tool-call results already "in" the conversation. | No — see below |
| `structured`    | Model invoked with `withStructuredOutput()` against a JSON Schema; scored by `fieldChecks`.                                                                                                                   | No             |
| `tool-call`     | Asserts the model calls a specific `tool`, optionally with `argChecks` on its arguments.                                                                                                                      | Yes            |
| `tool-sequence` | Like `tool-call`, but seeds one or more `priorTurns` (prior tool call + result pairs) before the final invoke, simulating a conversation already in progress.                                                 | Yes            |
| `human`         | Deferred to an interactive terminal review after the automated run (skipped entirely under `--ci`).                                                                                                           | No             |

`llm-judge` and `tool-sequence` share the same `priorTurns` seeding mechanism
(`buildSeededMessages()` in `lib/evaluations/src/runner.ts`) — each entry becomes a synthetic
`AIMessage(tool_call)` + `ToolMessage(result)` pair injected into the conversation before the
scenario's own final invoke. `llm-judge` never binds real tools to the model even when
`priorTurns` is set — it's scoring the model's follow-up text, not a fresh tool-call decision, so
there's nothing for it to call.

## Debugging: `DEBUG_LLM_HTTP`

Set `DEBUG_LLM_HTTP=1` to log the **raw HTTP response body** for every chat completion sent to
an `openai`-type provider, before the `openai` SDK/LangChain parses it:

```bash
DEBUG_LLM_HTTP=1 npm run eval -- --suite wiki-navigation --model local
```

This is diagnostic instrumentation (`api/src/services/provider-factory.ts`'s `loggingFetch`),
off by default and a no-op unless the env var is set to exactly `1`. Use it when a result's
`responseMetadata.finish_reason` doesn't match what actually got extracted (e.g.
`finish_reason: tool_calls` but `toolCalled: null` in the result) — logging the raw body lets you
compare byte-for-byte what the server actually sent against what the harness extracted, which
settles whether a discrepancy is server/model-side or a bug in our own parsing. Only applies to
`openai`-type providers (`ollama`/`anthropic` providers use different client libraries this hook
doesn't wrap).

**Redirect to a file rather than reading it live in a terminal** — the eval CLI's progress board
uses ANSI cursor movement to rewrite lines in place on a TTY, which visually interleaves with
and can truncate the debug log lines printed to the same stream:

```bash
DEBUG_LLM_HTTP=1 npm run eval -- --suite wiki-navigation --model local > eval-debug.log 2>&1
```

Once redirected, `stdout.isTTY` is false and the progress board falls back to plain sequential
printing instead, so the captured log stays intact and diffable.

## Output

Every run writes to `eval-results/` at the project root:

- `<suite-id>-<timestamp>.yaml` — always written. Structured, parseable result data: the full
  `run` summary (including `systemPrompt`, the exact harness prompt used, when applicable) and
  every scenario's `ScenarioResult`.
- `<suite-id>-<timestamp>.html` — written unless `--no-html`. A browsable report with the same
  data, plus collapsible per-scenario detail panels.

When the shared SQLite database is reachable, results are **also** written there
(`eval_runs`/`eval_results` tables) — this is what `npm run eval:calibrate` and
`npm run eval:compare` (below) read from; both require the database, not just the YAML/HTML
files, since they look runs up by id.

## Related Tools

The `eval` script is the one you run day to day; these cover authoring new scenarios and
working with past results. All are plain `tsx` wrappers (`npm run <script> -- <flags>`, same
`--` convention as `eval`) and share `eval`'s prerequisites (provider configured, database
reachable where noted).

| Script            | Command                                                                | Purpose                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eval:new`        | `tsx bin/eval-new.ts --suite <id> [--detached]`                        | Appends a new scenario stub to an existing suite file — interactively by default, or non-interactively with `--detached`.                                                                                                                                                                                                |
| `eval:from-trace` | `tsx bin/eval-from-trace.ts --trace-id <id> --suite <id> [--detached]` | Generates a new eval scenario from a captured production trace (found via its trace id in the observability store), so a real observed conversation — good or bad — becomes regression coverage directly.                                                                                                                |
| `eval:calibrate`  | `tsx bin/eval-calibrate.ts --run-id <id>`                              | For a past run (looked up in the database), walks every `llm-judge` result, shows the rubric and output blind (the judge's own score withheld until you answer), then reports human/judge agreement rate — use this to sanity-check whether a rubric is actually trustworthy before relying on it.                       |
| `eval:review`     | `tsx bin/eval-review.ts --run-id <id> [--detached]`                    | Writes a review manifest file for a run's `human`-type results still in `pending` status (e.g. an interactive review session that was interrupted before finishing — a `--ci` run's human scenarios are `skipped`, not `pending`, and aren't picked up here), so they can be scored outside the interactive terminal UI. |
| `eval:submit`     | `tsx bin/eval-submit.ts --manifest <path>`                             | Reads a filled-in manifest (from `eval:review`) and submits the human responses back into the database.                                                                                                                                                                                                                  |
| `eval:compare`    | `tsx bin/eval-compare.ts --run-a <id> --run-b <id>`                    | Compares two past runs by id and writes an HTML diff report — which scenarios improved, regressed, or stayed the same between them. Useful for before/after comparisons across a prompt change.                                                                                                                          |
