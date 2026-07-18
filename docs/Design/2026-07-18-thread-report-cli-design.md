# Thread Report CLI Design

**Date:** 2026-07-18
**Status:** Draft
**Related:** [`docs/Design/2026-07-18-persistent-conversation-memory-design.md`](./2026-07-18-persistent-conversation-memory-design.md), [`docs/Design/2026-07-17-afteragent-middleware-design.md`](./2026-07-17-afteragent-middleware-design.md), [`docs/Design/2026-07-15-evaluation-harness-design.md`](./2026-07-15-evaluation-harness-design.md)

## Purpose

A CLI that takes a `threadId` and generates a single, self-contained HTML report — no external resources, no server, no build step to view it — covering that thread from three angles: aggregate stats, an observability-level execution trace (including AfterAgent/wiki activity), and the conversation as the user actually experienced it.

The audience is developers and AI coding agents debugging the system, not end users. The purpose is operational: given a thread that produced unexpected behavior (a silent AfterAgent failure, a tool call that misbehaved, a turn that errored), the report should make "what actually happened, in what order, and why" legible from a single artifact, without needing a live running instance, log tailing, or manual SQL against the DB.

## Background

This came directly out of a live debugging session in this repo: an AfterAgent pipeline error was reported with an empty `err: {}` in the logs (fixed separately — see the error-logging fix), and once the real error was visible, it took another round of tracing through `stream-handler.ts`'s context-building to find the actual bug (a `model: model ?? ''` coercion breaking `createProviderFromConfig`'s fallback). Both of those required manually reading logs and tracing call sites by hand. A thread report would have shown the AfterAgent trace's failed span with its real error, timing, and position relative to the rest of the turn, in one place.

Two prior features make this possible without new instrumentation:

- **Persistent Conversation Memory** (`ThreadStore`) already persists every message in a thread — user, assistant, tool calls, HITL prompts, wiki updates — with `seq` ordering and status.
- **Observability** (`ObservabilityStore`) already persists a trace-and-spans record for every LLM/tool invocation, tagged with `threadId`. AfterAgent's background pipeline calls `startTrace({ threadId, ... })` too, using the _same_ `threadId` as the turn that triggered it, and its LLM-call spans are named with an `after-agent:` prefix (`after-agent:summarize`, `:classify`, `:extract`, `:merge-page`).

So everything the report needs already exists in the SQLite database; this feature is entirely a read/render layer, not a new data-capture mechanism.

## Scope decisions (from brainstorming)

- **Data source: DB-only.** The report is built purely from `ThreadStore` + `ObservabilityStore` queries against the SQLite file — no log file parsing. This means it's fully deterministic and can be regenerated any time after the fact from just the DB, but it cannot show the exact text of the `AfterAgent triggered`/`no-op`/`identified` log lines verbatim — whether a given AfterAgent run was a no-op is _inferred_ from which spans exist in its trace (a `classify` span with no following `extract` span ⇒ no-op), not read from a log.
- **Templating: nunjucks, reusing the evaluation report's pattern.** `lib/evaluations/src/serializer.ts` already establishes the self-contained-HTML approach used here: a nunjucks `.njk` template plus a `base.css` file read from disk and inlined via `<style>{{ styles | safe }}</style>`, with a small vanilla-JS theme toggle. No new templating engine, no client-side framework — this is a static document, not an app.
- **Trace detail: full span detail**, not a collapsed turn-level summary. Every span (LLM call or tool call) is its own row with type, name, latency, token counts, and truncated input/output preview. AfterAgent's spans are visually distinguished from the main turn's spans (separate lane/label), interleaved chronologically. Span errors are highlighted.
- **Failure count: span-level errors**, not turn-level (`status: 'error'`) failures. Counting spans with a non-null `error` field surfaces internal failures even when the turn itself completed successfully from the user's point of view — exactly the AfterAgent-fails-silently-in-the-background case this was built for. (Turn-level failures are still visible directly in the conversation view via the existing error/retry styling — they aren't hidden, just not double-counted as a separate top-level stat.)
- **Turn count:** count of `thread_messages` rows with `kind: 'user'`.

## Report Structure

### 1. Stats area

A row of stat cards (same visual pattern as the eval report's `meta-grid`):

| Stat              | Definition                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turns             | Count of `thread_messages` rows with `kind: 'user'`                                                                                              |
| Tool calls        | Count of `thread_messages` rows with `kind: 'tool_call'`                                                                                         |
| Most popular tool | Mode of `toolName` across those tool-call rows (ties broken alphabetically); "—" if no tool calls                                                |
| Failures          | Count of observability spans (across every trace tagged with this `threadId`, main-turn or AfterAgent) with a non-null `error`                   |
| Wiki writes       | Count of `thread_messages` rows with `kind: 'wiki_update'` — surfaced here as its own stat since it's the thing this tool exists to make visible |

### 2. Trace view

One chronological timeline combining every observability trace tagged with this `threadId`:

- **Main-turn traces** — one per `streamChatToSse`/`resumeChatToSse`/`retryChatToSse` call. Spans are whatever the `ObservabilityCallbackHandler` recorded during that turn (LLM calls, tool calls), in call order.
- **AfterAgent traces** — one per background pipeline run. Identified by containing at least one `after-agent:`-prefixed span name. Rendered in a visually distinct lane/color from main-turn traces, and labeled with its outcome:
  - No `classify` span → pipeline didn't get that far (early return: kill switch off, or empty turn text — indistinguishable from span data alone, labeled generically).
  - `classify` span present, no `extract` span following → **no-op** (classify decided nothing was worth saving).
  - `extract` (and possibly `merge-page`) span present → **identified** (a wiki write was attempted; check for a matching `wiki_update` thread_messages row whose timestamp falls within that trace's `startedAt`/`endedAt` bounds to confirm it actually committed, since the pipeline can still fail after `extract` — e.g. an unregistered domain or an unknown `domainId`, both handled today as a `logger.warn` + early return rather than a thrown/span-level error).
- **`wiki_update` messages** are plotted inline on the same timeline as concrete markers ("wrote/updated _Page Title_ (`type`) in `wikiName`"), positioned by their `seq`/timestamp, giving a direct visual link between an AfterAgent trace and the page it produced.
- Each span row shows: type icon (llm-call/tool-call), name, start time (relative to thread start and wall-clock), latency, input/output token counts, and a truncated preview of input/output. Spans with a non-null `error` are highlighted and show the error text in full (not truncated).

This view directly answers "how did the conversation get here" — it's the full causal chain, not just the visible chat.

### 3. Conversation view

Every `thread_messages` row, in `seq` order, rendered the way the live chat UI renders it: user/assistant bubbles (assistant content through the same markdown renderer conventions used elsewhere), tool-call chips (collapsed input/output, status), HITL prompt/answer pairs, and wiki-update chips — inline, at the point they occurred. Retried turns show both the failed attempt and its replacement (no filtering by `showErrorMessages` — this is a debugging report, not the live UI, so nothing is hidden by default).

This is deliberately _not_ a filtered "clean transcript" — the goal is "what did the user actually see," including the messy bits (a tool call chip mid-response, a HITL pause), because that's the experience being debugged.

## Data Model

```ts
// lib/thread-reports/src/types.ts

export interface ThreadReportData {
  threadId: string;
  generatedAt: string; // ISO timestamp, report generation time
  thread: ThreadDetail; // from ThreadStore.getThread() — messages already include seq/status
  stats: ThreadReportStats;
  timeline: TimelineEvent[]; // merged, time-ordered trace + wiki_update events
}

export interface ThreadReportStats {
  turnCount: number;
  toolCallCount: number;
  mostPopularTool: string | null;
  failureCount: number;
  wikiWriteCount: number;
}

export type TimelineEvent =
  | {
      kind: 'trace';
      source: 'main-turn' | 'after-agent';
      trace: TraceWithSpans;
      outcome?: 'no-op' | 'identified';
    }
  | {
      kind: 'wiki_update';
      seq: number;
      pageTitle: string;
      pageKind: string;
      wikiName: string;
      at: string;
    };
```

`TraceWithSpans` and `ThreadDetail` are the existing types from `@tkottke90/llm-common-types/traces` and `ThreadStore`, respectively — this package adds no new persistence types, only a read-side aggregation shape.

## CLI Interface

```sh
npm run thread-report -- --thread <threadId> [--db <path>] [--out <dir>]
```

- `--thread` (required): the thread ID to report on.
- `--db` (optional): path to the SQLite database file. Defaults to `env.database.path` (same resolution `bin/eval.ts` uses via `openDatabase`).
- `--out` (optional): output directory. Defaults to `thread-reports/` at the repo root (sibling to `eval-results/`).

Output: `thread-reports/<threadId>-<sanitized-timestamp>.html`. On success, prints the absolute path to stdout. Exits with code 2 and a clear message if `--thread` is missing or the thread doesn't exist in the DB (mirrors `bin/eval.ts`'s exit-code convention for bad CLI usage).

## File Layout

New package `lib/thread-reports`, mirroring `lib/evaluations`'s shape:

```
lib/thread-reports/
  src/
    types.ts          # ThreadReportData and friends (above)
    build.ts           # buildThreadReport(threadId, { threadStore, obsStore }): ThreadReportData
    render.ts           # renderThreadReportHtml(data): string — nunjucks setup, mirrors serializer.ts
    index.ts
  templates/
    report.njk
    base.css            # start from lib/evaluations/templates/base.css, extend as needed
  package.json
bin/
  thread-report.ts       # CLI wrapper: parseArgs, openDatabase, call build+render, write file
```

`buildThreadReport` takes already-open store instances (not a DB path) so it's unit-testable against temp-file stores the same way `ThreadStore`'s own tests work — the CLI script is the only place that opens the database and resolves paths, matching this repo's "route/CLI layers are thin, logic underneath is directly testable" convention used throughout `api/`.

## Testing

- `lib/thread-reports/src/build.ts`: unit tests against real temp-file `ThreadStore`/`ObservabilityStore` instances (no mocking of SQLite — same pattern as `thread-store.test.ts`) — seed a thread with a mix of main-turn and AfterAgent traces (including a deliberately no-op run, an identified/wiki-write run, and a failed span) and assert the computed `ThreadReportStats` and `TimelineEvent` ordering/classification are correct.
- `lib/thread-reports/src/render.ts`: a small snapshot/smoke test that `renderThreadReportHtml` produces valid, non-empty HTML containing expected markers (stat values, thread ID) for a known `ThreadReportData` fixture — not a full HTML-diff test, just enough to catch template breakage.
- `bin/thread-report.ts`: no direct test (thin CLI wrapper, same as `bin/eval.ts`); covered by manually running it against a locally seeded thread as part of implementation verification.

## Non-goals

- No live/streaming mode — this is a point-in-time snapshot generated on demand, not a dashboard.
- No cross-thread aggregation or comparison (that's closer to the existing eval-comparison report's territory, not this tool's).
- No editing/interactivity beyond the theme toggle — the HTML is a read-only artifact.
- Not wired into the API or UI in this iteration — CLI-only, for local developer/agent use.
