# AGENTS.md

Instructions for agents (and humans) working in this repository.

## What this is

`amazing-hashbrown` is a local LLM agent harness: a persona knowledge base and
autonomous assistant. It's an npm-workspaces monorepo with two apps:

- `api/` — Express REST API, LangChain agents, knowledge base (see `api/AGENTS.md`)
- `ui/` — Preact web frontend (see `ui/AGENTS.md`)

Read the `AGENTS.md` in whichever workspace you're changing before making
edits there — it has directory-specific conventions this file doesn't repeat.

## Stack

TypeScript everywhere, npm workspaces, ESLint + Prettier (shared root config),
Node.js 20+ (Docker image targets `node:24`).

## Setup

```sh
npm install
cp .env.example .env
```

## Common commands (run from repo root)

```sh
npm run dev:api       # start the API in watch mode
npm run dev:ui        # start the Vite dev server (proxies /api to the API)
npm run build         # build both workspaces
npm test              # run api (Mocha) and ui (Jest) test suites
npm run test:e2e      # full Playwright E2E suite (requires Ollama running locally)
npm run test:e2e:ci   # CI-safe E2E subset (excludes @llm tests, no Ollama needed)
npm run lint          # ESLint across the whole repo
npm run format        # Prettier --write across the whole repo
```

There is no per-workspace lint/format script — ESLint and Prettier are
configured once at the repo root (`eslint.config.js`, `.prettierrc.json`) and
apply to both `api/` and `ui/`.

## Git Workflow

This repository uses **Trunk Flow**: `main` is the single integration branch. All work happens on short-lived feature branches that are merged directly into `main` via pull request — there are no long-lived `develop`, `staging`, or release branches.

- Branch from `main`, merge back to `main`
- Keep branches short-lived; avoid letting them drift far from `main`
- PRs require passing CI (lint, style, tests) before merge

## TODO List

Outstanding work is tracked in [`TODO_LIST.md`](./TODO_LIST.md) at the repo root.

When a branch implements an item from that file, **mark it as complete on the same branch** — move it from the "Outstanding Items" list into the "Completed Items" list and update the numbering. That way the TODO list is already accurate the moment the branch is merged into `main`; no separate cleanup commit is needed.

## Before committing

**Tests, linting, and style checks must all pass before you make a commit.**
Run, from the repo root:

```sh
npm run lint
npx prettier --check .
npm test
```

If any of these fail, fix the issue before committing — don't commit with
`--no-verify` or otherwise bypass the check.

## CI

`.github/workflows/` runs checks whenever a PR is opened, reopened, or updated
with new commits. Four jobs run in parallel:

- `test` (`tests.yml`) — Mocha (API/libs) and Jest (UI) unit tests
- `e2e` (`tests.yml`) — Playwright CI-safe subset (non-`@llm` tests only)
- `lint` (`lint.yml`) — ESLint
- `style` (`style.yml`) — Prettier format check

All should be green if you ran the pre-commit checks above locally.

## Docker

The root `Dockerfile` is a multi-stage `node:24` build: it compiles both
workspaces, installs production-only dependencies (`npm ci --omit dev`), and
assembles a runtime image that serves the built `ui` app as static files from
the `api` server. See `api/AGENTS.md` for how static hosting is wired up.

## Testing

**Non-negotiable: all application code must have tests.** Routes, agents, tools, services, and middleware ship with tests. Untested code is not considered complete and will not be merged.

Tests add value through validation and regression checks. The tests themselves must follow these principles:

1. **Tests only give value when you put value in** — descriptions should highlight what is being tested and why it matters; failures should explain _why_ they failed, not just that they did
2. **Tests are cumulative** — many small, focused tests are better than one large test that checks everything at once
3. **Tests assert on behaviour, not implementation** — answer "how do we expect this code to behave?" not "what functions did it call?"
4. **Tests are deterministic** — a test must produce the same result every time it runs

### When Not to Test (Testing Blacklist)

Not everything needs a test. Before writing one, ask:

1. Does this codebase have any control over the outcome?
2. Does this file do any processing?

If the answer to both is no, skip the test. Things that typically qualify:

- Third-party library wiring (`loadConfig`, `configureFromSchema`, `createReactAgent` call sites)
- Pure type/interface files, Zod schema definitions with no runtime behaviour
- Barrel/re-export files (`index.ts` files that only collect and re-export)

Everything else must be tested.

### Developer Tests

Developer tests run in isolation — no live external services required. They can run locally or in CI without heavy setup. Framework: **Mocha + Chai** (`api/`, `lib/`), **Jest** (`ui/`).

Test files live **adjacent to the source file they test**: `src/agents/chat-agent.ts` → `src/agents/chat-agent.test.ts`.

Append a tag to the end of each test name to identify its type:

```ts
enum TestTypes {
  UNIT = '[unit]',
  ORCHESTRATION = '[orchestration]',
  EXTERNAL = '[external-orchestration]',
}

it(`returns error when input is null ${TestTypes.UNIT}`, () => {});
it(`delegates to the correct handler ${TestTypes.ORCHESTRATION}`, () => {});
it(`handles a 404 from the upstream API ${TestTypes.EXTERNAL}`, () => {});
```

#### Unit Tests

Scope: a single function or module in complete isolation. All external dependencies (filesystem, HTTP clients, databases, LangChain models) are replaced with stubs or mocks.

This is the **default test type** — reach for it first.

**Best practices:**

- Each test covers one specific scenario or edge case
- Name tests descriptively: `returns error when input is null` is better than `calls validateInput`
- Cover both the happy path and failure/edge cases
- Keep test logic simple — if a test needs its own conditionals, it's doing too much

#### Orchestration Tests

Scope: multiple internal units wired together, but no real external I/O. The goal is to verify that units are composed correctly — not to re-test the units themselves.

**Best practices:**

- Focus on interactions between units (was the right function called with the right arguments?) rather than on the results those units produce
- Prefer spying over mocking where possible — a spy verifies the call without replacing behaviour
- Use in-process test clients (e.g. `supertest`) to exercise full request → middleware → handler → response pipelines

#### External Orchestration Tests

Scope: the boundary between this application and an external system (HTTP API, database, MCP server, message queue). These tests do **not** connect to the real external system — they mock responses to exercise every scenario the application might encounter.

Two things to verify for every external boundary:

1. **Outbound contract** — the application sends the right thing (correct method, path, query params, body shape, headers)
2. **Inbound handling** — the application correctly handles the full range of responses: success, expected errors (e.g. unique-constraint violation, 404), and unexpected failures

**Best practices:**

- Always mock external services — never make real calls in a developer test
- Test all documented error scenarios, not just the happy path
- Use spies to verify that the correct input is constructed and sent
- Build mock responses from real API documentation or SDK response types — this makes the test double as documentation
- Note which version of the external API or SDK the test targets so it's clear when the test may be stale

### End-to-End Tests

E2E tests run against a live instance of the application and verify complete user-facing flows. Unlike developer tests they are not exhaustive — focus on expected paths. Framework: **Playwright**.

Use Playwright tags to classify tests:

```ts
enum E2ETestTypes {
  FUNCTIONAL = '@functional',
  USER_WORKFLOW = '@user-workflow',
  SMOKE = '@smoke',
  COMPREHENSIVE = '@comprehensive',
}
```

| Tag              | When to use                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `@smoke`         | Fast checks of core functionality; run frequently; mocking APIs is acceptable |
| `@comprehensive` | Full feature verification run to completion; used after deployments           |
| `@functional`    | Non-user-facing flows: background jobs, webhooks, system integrations         |
| `@user-workflow` | Simulates a user completing a task in the UI                                  |

Structure each test suite with the `TestSuite` pattern to capture intent alongside the test logic:

```ts
interface TestSuite {
  id: number;
  name: string;
  description: string; // what the suite is testing
  purpose: string; // value the feature provides
  tags: string[];
  steps: Array<{
    tags: string[];
    action: string; // plain-language description of what's done
    expectedOutcome: string; // plain-language description of what should happen
    test: () => void;
  }>;
}
```

**Best practices (user workflow tests):**

- Use semantic selectors (`getByRole`, `getByLabel`, test IDs) — not CSS class or DOM hierarchy
- Test from the user's perspective: "user can submit the form", not "form submit handler called"
- Clean up any data created during the test, even on failure
- Wait for specific conditions (element visible, text appears) rather than arbitrary timeouts

**Best practices (functional tests):**

- Always clean up test data after each run
- Use the same seed data on every run to keep tests deterministic
- Verify actual state changes — check the database, queue, or downstream system directly, not just the HTTP response

### Testing Anti-Patterns

#### Testing Log Messages

```ts
// ❌ Don't
it('creates a record', () => {
  const spy = sinon.spy(logger, 'info');
  createRecord({});
  expect(spy).to.have.been.calledWith('Record created');
});

// ✅ Do — assert on the observable outcome, not the log line
it('creates a record', async () => {
  const record = await createRecord({ name: 'test' });
  expect(record.id).to.be.a('string');
});
```

Log messages are not part of the public contract, change frequently, and testing them produces brittle tests that break on unrelated log wording changes.

---

## UI State Management

The `ui/` workspace uses `@preact/signals` for component state. Prefer
`useSignal`/`useComputed` over `useState`/`useReducer`. See `ui/AGENTS.md`
for details.

---

## Evaluation-Driven Development (EDD)

This project uses an **Evaluation Harness** (`lib/evaluations`, `bin/eval*`) to verify LLM-facing behaviour under real model conditions. Results are written to `eval-results/` (gitignored).

### Rules

1. **Before implementing a new LLM-facing feature**: write at least one failing eval scenario first (`npm run eval:new -- --suite <id>`), then implement until it passes.
2. **When filing a bug involving LLM output**: add a failing eval scenario that reproduces the bug _before_ writing the fix. Reference the issue number in the scenario `id` (e.g. `bug-42-agent-refuses-tool-call`).
3. **When fixing an LLM-facing bug**: the failing eval must be green before the PR is merged.
4. **Scenario `purpose` field is required**: it must answer "why does this test matter?" — not just describe what it tests.

### Quick reference

```sh
# Run a suite
npm run eval -- --suite wiki-search --model ollama --judge-model ollama

# CI mode (human evals skipped, exit code 1 on failure)
npm run eval -- --suite wiki-search --model ollama --ci

# Author a new scenario interactively
npm run eval:new -- --suite wiki-search

# Author a new scenario (detached / agent-friendly)
npm run eval:new -- --suite wiki-search --detached

# Scaffold a scenario from an observability trace
npm run eval:from-trace -- --trace-id <id> --suite wiki-search

# Interactive human review of pending results
npm run eval:review -- --run-id <id>

# Detached human review (writes a manifest file for agents)
npm run eval:review -- --run-id <id> --detached
npm run eval:submit -- --manifest eval-results/<id>-review.json

# Compare two runs side-by-side
npm run eval:compare -- --run-a <id> --run-b <id>
```

Results are written to `eval-results/`. HTML reports are self-contained and open in any browser.

### Suite files

Bundled suites live in `suites/` and are checked into git. Each file defines one suite. The `wiki-search.yaml` suite is the canonical example and the first acceptance test for the agent's knowledge base feature.

### Scenario types

Each scenario in a suite YAML declares a `type` (see `lib/evaluations/src/schemas.ts` for the full field-level schema of each):

- `deterministic` — exact/contains/regex match against the model's raw text output
- `semantic` — embedding similarity against an expected response
- `llm-judge` — a second model scores the response against a rubric
- `structured` — asserts on fields of a `withStructuredOutput()` result
- `tool-call` — asserts the model calls a specific tool (with optional arg checks) for a single-turn prompt
- `tool-sequence` — like `tool-call`, but seeds a synthetic prior tool call + result into the conversation first, for testing multi-turn tool chains (e.g. does the agent correctly relay a prior tool's output into `upload_image`)
- `human` — deferred to an interactive review pass (`eval:review`)
