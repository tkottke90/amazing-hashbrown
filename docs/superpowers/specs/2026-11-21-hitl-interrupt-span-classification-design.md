# Thread Report HITL interrupt span classification — Design

Issue: #404

## Problem

`ask_user` and `shell_exec` both pause the graph by calling LangGraph's `interrupt()`, which throws a `GraphInterrupt` from inside the tool function. `ObservabilityCallbackHandler.handleToolError` (`api/src/agents/observability-handler.ts`) catches that throw like any other tool failure and records `error: err.message` on the span — before the throw ever reaches `recoverThrownInterrupt`, the code that correctly treats it as a successful HITL pause rather than a turn failure. `lib/thread-reports/src/build.ts`'s `failureCount`/Failure Breakdown logic then counts that span as a real failure, and `lib/thread-reports/templates/report.njk` renders it with `.span-error-text` — the same red styling as a genuine error. This is purely a **span**-level bug: the owning trace's own `error` field is already correctly left `null` on a successful interrupt (`task-execution.ts`'s `GraphInterrupt` branch never sets `traceError` on the `recovered.interrupted` path), so no trace-level change is needed.

## Decision: detection mechanism

See **ADR-0075** and **GLOSSARY.md "Interrupted Span"** for the chosen mechanism and why the alternatives (text/name matching in `thread-reports`) were rejected. Summary for cross-reference only: `handleToolError` checks `err.name === 'GraphInterrupt'` and records the span with `error: null` and a new `interrupted: true` flag, rather than inferring the distinction downstream from tool name or error text.

## Changes

### 1. `SpanRecord` schema (`lib/llm-common-types/src/traces/types.ts`)

Add `interrupted: z.boolean()` to `SpanRecordSchema`, immediately after `error`. Meaningful only for `type: 'tool-call'` spans (the only kind that can ever throw a `GraphInterrupt` — `interrupt()` is only called from inside `ask_user.tool.ts` and `shell-exec.tool.ts`); always `false` for `llm-call`/`attachment` spans and for a tool-call span that didn't interrupt.

### 2. `observability_spans` migration (`lib/observability/src/store.ts`)

Add a migration: `ALTER TABLE observability_spans ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0;` — next version number is **48** at time of writing (highest in use across the shared migration sequence is 47); confirm against `MIGRATIONS` arrays repo-wide immediately before implementing, since other in-flight work may have claimed it since. Historical rows read `interrupted: false`, which is already how they display today — no backfill (see ADR-0075's accepted consequence). `saveSpans()`'s `INSERT` and `RawSpanSchema` (the row-to-`SpanRecord` mapping `getTrace()` parses through) both need the new column threaded through.

### 3. `ObservabilityCallbackHandler` (`api/src/agents/observability-handler.ts`)

- `handleToolError`: when `err.name === 'GraphInterrupt'`, push the completed span with `error: null, interrupted: true` instead of `error: err.message, interrupted: false`.
- Every other span-construction site in this file (`handleLLMEnd`, `handleLLMError`, `handleToolEnd`, `handleToolError`'s non-interrupt branch, `flushPendingAsFailed`) sets `interrupted: false` explicitly, so `SpanRecord` is always fully populated.

### 4. `ThreadReportStats` (`lib/thread-reports/src/types.ts`)

Add `toolInterruptCounts: Record<string, number>` next to `toolFailureCounts` — count-only (no `example`, unlike `toolFailureCounts`: an interrupted span's `error` is `null`, so there is no example error text to carry). Always present (empty object when nothing paused), matching this interface's existing no-optional-fields convention.

### 5. `build.ts`

- `computeFailureBreakdown`'s `erroredSpans` filter (`span.error !== null`) already excludes an interrupted span with no changes, since `error` stays `null` for one — `failureCount` and `toolFailureCounts` self-correct with zero new logic.
- Add a sibling computation (alongside `computeFailureBreakdown`, same traces-iteration shape) that buckets `trace.spans.filter(s => s.type === 'tool-call' && s.interrupted)` by `span.name` into `toolInterruptCounts`. Merge its result into the object `buildThreadReport` returns, the same way `computeFailureBreakdown`'s result is merged today.

### 6. `report.njk` + `base.css` (`lib/thread-reports/templates/`)

- **Tool Calls rollup** (the `stats.toolCallCounts` loop): alongside the existing `{% set failure = stats.toolFailureCounts[name] %}`, add `{% set interrupted = stats.toolInterruptCounts[name] %}`. When present, append `, {{ interrupted }} paused` to the call-count line and render a small badge (text `paused`, new class e.g. `.span-badge-interrupt`) — same pattern as the existing `.outcome-badge`/`.step-badge-warn` badges, styled with the existing `--warn`/`--warn-bg` tokens. A tool can have both a `failure` and an `interrupted` count (e.g. two `ask_user` calls, one paused successfully, one that genuinely errored some other way) — render both suffixes.
- **Per-span rendering in the trace timeline** (the `event.trace.spans` loop): add `'span-interrupt' if span.interrupted` alongside the existing `'span-error' if span.error` class (mutually exclusive in practice, since an interrupted span's `error` is always `null`). Render the same `paused` badge in the summary row. The existing `{% if span.error %}` block already won't render for an interrupted span, so no explicit suppression is needed — only an addition.
- **`base.css`**: add `.span-row.span-interrupt` (border/left-accent in `--warn`, mirroring `.span-row.span-error`'s use of `--fail`) and `.span-badge-interrupt` (same shape as the existing badge classes, `--warn`/`--warn-bg`). Mirror both rules into `lib/workspace-reports/templates/base.css` too, matching that file's existing practice of carrying every Thread Report span style even though its own template never renders a span directly — keeps the two files from drifting further apart, consistent with how `.span-error-text` etc. are already duplicated there today.

## Explicitly out of scope

- No change to `workspace-retrospective-narrative.ts`'s evidence rendering (`toolDistributionLines`/`otherFailureLines`) — the "N/M failed" mislabeling it could produce for a paused tool is already fixed as a side effect of (5) above; adding a symmetrical "paused" mention there is a separate, un-reported enhancement.
- No change to `lib/workspace-reports` itself — it only sums `ThreadReportStats.failureCount` (`chat?.stats.failureCount`, `run.threadReport?.stats.failureCount`), which is already correct once (5) lands.
- No backfill/migration of historical spans — see ADR-0075.
- No new top-level Thread Report stat card (e.g. a standalone "HITL Pauses" metric) — `toolInterruptCounts` only extends the existing per-tool rollup.
- No E2E/Playwright coverage — `e2e/tests/thread-report.spec.ts` mocks the entire report HTML and only tests that the "Generate thread report" buttons open it in a new tab; it never exercises real span/stat rendering. That's `lib/thread-reports/test/unit/render.test.ts`'s job.
- No eval scenario — this changes no LLM-facing behavior, only how an already-correct interrupt pause is recorded and rendered.

## Testing

Developer tests only, per the sections above:

- `api/src/agents/observability-handler.test.ts` — unit: `handleToolError` given an `Error` named `GraphInterrupt` produces a completed span with `error: null, interrupted: true`; given any other error, `interrupted: false` as before.
- `lib/observability` store tests — the new column round-trips through `saveSpans`/read, defaulting `false` for a span inserted without it (historical-row shape).
- `lib/thread-reports/test/unit/build.test.ts` — `failureCount`/`toolFailureCounts` exclude an interrupted span; `toolInterruptCounts` is populated correctly, including the two-interrupted-and-one-failed-for-the-same-tool case.
- `lib/thread-reports/test/unit/render.test.ts` — an interrupted span renders `span-interrupt`/the `paused` badge and not `span-error`/`.span-error-text`; the Tool Calls rollup shows the "N paused" suffix.
