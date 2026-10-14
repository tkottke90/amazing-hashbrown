# Remote trace → eval scenario extraction

Issue: [tkottke90/amazing-hashbrown#296](https://github.com/tkottke90/amazing-hashbrown/issues/296)

## Problem

`npm run eval:from-trace` (`bin/eval-from-trace.ts`) turns a captured
production trace into a reusable eval scenario, but it only works colocated
with `app.db` — it opens the observability SQLite database directly, with no
network path at all. During a recent production incident investigation this
meant the only way to pull a trace's diagnostic data onto a different
machine was SSH + filesystem access to `app.db`.

A read-only `/api/v1/traces` surface already exists
(`GET /api/v1/traces/:traceId` returns the full `TraceWithSpans`), but it
isn't sufficient on its own:

- `llm-call` spans' `inputPreview` is **always `null`** — the model's input
  lives only in the LangGraph checkpoint, which has no lookup-by-trace API.
  `eval-from-trace.ts`'s current `?? 'TODO - extract from trace'` fallback
  fires almost every run because of this.
- `tool-call` spans' `outputPreview` is truncated to
  `observability.spanOutputPreviewChars` (default 500 chars).

The full, untruncated content — the opening user message, every tool call's
real args/outputs, the model's final reply — exists only in the thread's
message history (`ThreadStore`), reachable via `trace.threadId`.

## Decision

Build a **purpose-built** endpoint,
`GET /api/v1/traces/:traceId/scenario-source`, rather than just pointing the
CLI at the existing `/traces/:traceId` route. It joins a trace's spans (for
ordering/structure) with its linked thread's full messages (for untruncated
content) into scenario-authoring-ready data. This is intentionally reusable
beyond the CLI: the same capability can back a future in-app "capture this
trace as an eval scenario" feature, not just `bin/eval-from-trace.ts`.

Auth is explicitly out of scope — it matches the existing unauthenticated
`/api/v1/traces/*` routes. This is a known, pre-existing gap (every route in
this app except `POST /api/v1/webhooks/tasks` is unauthenticated), not one
introduced by this change.

## Design

### `lib/evaluations/src/trace-scenario-source.ts`

A pure, independently-testable module — the trace+thread joining logic,
reusable by both the new endpoint and any future in-app feature.

```ts
export interface ScenarioSourceMessage {
  kind: string; // 'user' | 'assistant' | 'tool_call' | other thread kinds
  seq: number;
  payload: unknown;
}

export interface ScenarioSource {
  traceId: string;
  threadId: string | null;
  source: TraceSource;
  provider: string;
  model: string;
  error: string | null;
  turns: ScenarioTurnSeed[]; // {user} / {tool,args,result} — ToolTurnSchema/userTurn shape
  finalToolCall: { name: string; args: unknown } | null;
  finalAssistantText: string | null;
  incomplete: boolean;
  incompleteReason?: string;
}

export function buildScenarioSource(
  trace: TraceWithSpans,
  messages: ScenarioSourceMessage[],
): ScenarioSource;
```

Algorithm:

- Walks `trace.spans` in order. For each `tool-call` span, finds the next
  unconsumed `tool_call` thread message whose `toolName` matches the span's
  `name` — **matching by name + chronological order, not by ID**: trace
  `tool-call` spans use LangChain's own `runId` as `spanId`, while thread
  `tool_call` messages use LangGraph's `tool_call.id`. These are different
  ID spaces.
- Pulls full `args` from the matched thread message's `inputs` and full
  `result` from its `outputs`. Falls back to the span's own (truncated, or
  entirely absent) preview data when no match is found, or when a matched
  tool call never finalized (errored or still pending) — and sets
  `incomplete: true` with a reason, rather than failing.
- The opening `{user}` turn is the thread's last `user` message at or before
  `trace.startedAt`. A multi-tool-call trace with no new user input between
  calls (the motivating recursion-loop example) naturally produces
  `[{user}, {tool,...}, {tool,...}, ...]` — `ToolSequenceScenarioSchema`'s
  `turns` only requires starting with `{user}`, not alternating.
- The trace's **last** `llm-call` span's `outputPreview` (already fully
  captured, never truncated to null) becomes `finalToolCall`/
  `finalAssistantText` — reference data for a human filling in the
  scenario's TODO fields, never seeded into `turns`.

`buildScenarioDraft(source, opts)` builds a `tool-sequence` scenario when
`source.turns` contains any tool entries, else `llm-judge`. The seeded
conversation is real, captured content; fields that require human judgment
about *correct* behavior (`tool`, `rubric`) stay as `TODO` placeholders, same
as today. Validates the result against `ScenarioSchema` — fails loudly on a
malformed draft rather than writing invalid YAML into a suite file.

`formatSuiteYamlBlock(scenario)` serializes with `stringify()` from the
`yaml` package (already a dependency, already used in
`lib/evaluations/src/serializer.ts`) and re-indents it as a 2-space-nested
list item, replacing today's hand-built template string and naive
`.replace(/"/g, '\\"')` escaping.

### `GET /api/v1/traces/:traceId/scenario-source`

New `api/src/routes/v1/traces.handlers.ts` — the first handlers file for
this route, following the repo's established `*.handlers.ts` convention
(`threads.handlers.ts`, `tasks.handlers.ts`, 17 others): a plain,
Express-agnostic function returning `HandlerResult<T>`
(`{ok:true,data}` / `{ok:false,status,error}`), unit-tested by calling it
directly — no `Request`/`Response`, no supertest/real-HTTP-server test. The
route itself (`traces.route.ts`) stays thin, untested wiring.

```ts
export function getScenarioSourceHandler(
  observabilityStore: ObservabilityStore,
  threadStore: ThreadStore,
  traceId: string,
): HandlerResult<ScenarioSource> {
  const trace = observabilityStore.getTrace(traceId);
  if (!trace) return notFound(`Trace ${traceId} not found`);
  const messages = trace.threadId
    ? threadStore.getThreadMessages(trace.threadId, { limit: Number.MAX_SAFE_INTEGER })
    : [];
  return ok(buildScenarioSource(trace, messages));
}
```

`ThreadStore.getThreadMessages` defaults to a 200-message display cap — the
handler calls it directly with an explicit high limit rather than going
through `getThread()`, whose narrower `opts` type doesn't expose `limit`.

### `bin/eval-from-trace.ts`

Drops `openDatabase()`/`bootObservability()` entirely. Adds a `--base-url`
flag (default `http://localhost:3000`) and fetches the new endpoint with the
native `fetch` (already the de facto HTTP client convention elsewhere in
this codebase — no new dependency). Writes a real scenario scaffold via
`buildScenarioDraft`/`formatSuiteYamlBlock` — real captured multi-turn
content instead of the `'TODO - extract from trace'` placeholder, and real
YAML serialization instead of hand-escaped template strings.

## Testing

- `lib/evaluations/test/unit/trace-scenario-source.test.ts` — unit tests on
  `buildScenarioSource`/`buildScenarioDraft`/`formatSuiteYamlBlock`: single
  turn with no tool calls, a multi-tool-call sequence matched by name/order,
  a tool call with no matching thread message, a tool call that never
  finalized (span-level error), no user message found, both draft shapes,
  and YAML round-tripping.
- `api/src/routes/v1/traces.handlers.test.ts` — unit tests against real
  (temp-file-backed) `ThreadStore`/`ObservabilityStore` instances, per this
  repo's established handler-test convention: trace not found (404), a trace
  with no linked thread (incomplete fallback), and — the key regression
  check — a trace joined against a thread seeded with 200+ messages, proving
  the handler reads past `ThreadStore`'s default display cap rather than
  silently truncating.
- No dedicated test for `bin/eval-from-trace.ts` itself: its CLI argv/fetch
  wiring falls under this repo's testing-blacklist precedent (no other
  `bin/*.ts` script has a `.test.ts`); the logic that matters is already
  covered in `trace-scenario-source.test.ts`.

Per this repo's updated testing convention (see `AGENTS.md`/`api/AGENTS.md`),
no test here spins up a server or uses `supertest`/an in-process HTTP
client — route logic is tested at the handler level; full-pipeline coverage
is an E2E concern, out of scope for this backend-only change.

## Out of scope

- **Auth** on `/api/v1/traces/*` — matches the existing unauthenticated
  surface; a known gap, not introduced here.
- Any in-app UI for capturing a trace as a scenario — the new endpoint is
  designed to support that later, but no UI work is part of this change.
