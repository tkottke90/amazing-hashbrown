# Observability — events, traces, and metrics

`@tkottke90/rlm` emits a structured event stream for every run. You can use it to stream live status to a UI, write structured logs to a database, build a visual trace viewer, or just print a human-readable summary after a run.

---

## Two observability modes

**Real-time events** — `RLMLogger.onEvent` fires for each event as it occurs. Use this when you need to update a UI incrementally or stream to a log sink while the run is in progress.

**Complete trace** — `RLMLogger.onTrace` fires once at run completion with a self-contained `RLMTrace` object. Use this for audit logs, post-run analysis, or to render `formatTrace`.

Both methods are optional — implement only what you need.

---

## Attaching a logger

Pass an `RLMLogger` as the fourth argument to `RLMRunner`:

```ts
import { RLMRunner, formatTrace } from '@tkottke90/rlm';
import type { RLMLogger } from '@tkottke90/rlm';

const logger: RLMLogger = {
  onEvent(event) {
    // fires for each event in order, as it happens
    console.log(event.kind, event.timestampMs);
  },
  onTrace(trace) {
    // fires once, at run completion
    console.log(formatTrace(trace));
  },
};

const runner = new RLMRunner(adapter, undefined, { think: false }, logger);
await runner.run(query, corpus);
```

---

## The event stream

For a run that calls `peek → grep → slice → final_answer`, the events arrive in this order:

```
run_started
iteration_started        (iteration: 1)
model_requested          (correlationId: "A")
model_responded          (correlationId: "A")
tool_dispatched          (correlationId: "B", tool: "peek")
tool_completed           (correlationId: "B")
iteration_started        (iteration: 2)
model_requested          (correlationId: "C")
model_responded          (correlationId: "C")
tool_dispatched          (correlationId: "D", tool: "grep")
tool_completed           (correlationId: "D")
iteration_started        (iteration: 3)
model_requested          (correlationId: "E")
model_responded          (correlationId: "E")
tool_dispatched          (correlationId: "F", tool: "slice")
tool_completed           (correlationId: "F")
iteration_started        (iteration: 4)
model_requested          (correlationId: "G")
model_responded          (correlationId: "G")
tool_dispatched          (correlationId: "H", tool: "final_answer")
tool_completed           (correlationId: "H")
run_completed
```

When `max_iterations` is reached, a `synthesis_triggered` / `synthesis_completed` pair is emitted after the last `tool_completed` and before `run_completed`.

---

## All event kinds

| `kind`                | Description                                                         | Has `correlationId`?                    | Key fields                                                      |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `run_started`         | Run begins.                                                         | No                                      | `query`, `corpusMeta`                                           |
| `iteration_started`   | A new model call is about to be made.                               | No                                      | `iteration`                                                     |
| `model_requested`     | Model call dispatched.                                              | Yes (paired with `model_responded`)     | `iteration`, `messageCount`, `messages?`                        |
| `model_responded`     | Model call returned.                                                | Yes                                     | `iteration`, `durationMs`, `content`, `rawContent`, `toolCalls` |
| `tool_dispatched`     | Tool call extracted from model response; about to execute.          | Yes (paired with `tool_completed`)      | `iteration`, `tool`, `args`, `phase`, `displayMessage`          |
| `tool_completed`      | Tool execution finished.                                            | Yes                                     | `iteration`, `tool`, `durationMs`, `result`                     |
| `loop_detection`      | Runner detected a repeated tool + args call and injected a warning. | No                                      | `iteration`, `tool`, `args`, `iterationsDeducted`               |
| `synthesis_triggered` | `max_iterations` hit; synthesis call starting.                      | Yes (paired with `synthesis_completed`) | —                                                               |
| `synthesis_completed` | Synthesis call returned.                                            | Yes                                     | `durationMs`, `content`, `hadToolCallEscape`                    |
| `run_completed`       | Run finished.                                                       | No                                      | `durationMs`, `terminationReason`, `found`, `iterations`        |

All events share `eventId: string` (UUID) and `timestampMs: number`.

---

## `correlationId` pairs — building a live UI

Matched-pair events share a `correlationId`. Use this to link a "started" state with its "completed" state without scanning the full event list:

```ts
const pending = new Map<string, string>(); // correlationId → tool name

const logger: RLMLogger = {
  onEvent(event) {
    if (event.kind === 'tool_dispatched') {
      pending.set(event.correlationId, event.tool);
      showSpinner(event.tool, event.displayMessage); // "Searching your memory..."
    }
    if (event.kind === 'tool_completed') {
      const tool = pending.get(event.correlationId);
      if (tool) {
        hideSpinner(tool);
        showResult(tool, event.result);
        pending.delete(event.correlationId);
      }
    }
    if (event.kind === 'run_completed') {
      clearAllSpinners();
    }
  },
};
```

The `displayMessage` field on `tool_dispatched` is the human-readable status string — the same value that `StatusCallback` would receive. This means you can drive a UI from either `onEvent` or `onStatus` interchangeably.

---

## `traceDetail` levels

Set via `RLMConfig.traceDetail`. Controls how much content is stored in events.

| Level              | `model_requested.messages`    | `model_responded.rawContent` | `tool_completed.result` |
| ------------------ | ----------------------------- | ---------------------------- | ----------------------- |
| `'full'` (default) | Full messages array           | Full wire content            | Full result string      |
| `'compact'`        | Omitted (only `messageCount`) | Full wire content            | First 200 chars         |
| `'minimal'`        | Omitted                       | Empty string                 | Empty string            |

Use `'compact'` or `'minimal'` in production to reduce memory usage. `'full'` is best for development and debugging.

```ts
const runner = new RLMRunner(adapter, undefined, { think: false, traceDetail: 'compact' });
```

---

## `RLMResult` derived fields

After the run, three derived fields are available directly on `RLMResult`:

**`result.events`** — the full ordered event array, identical to what `RLMLogger.onEvent` received. Use `deriveSourcesUsed` and `deriveMetrics` on a saved event array to recompute derived data without re-running.

**`result.metrics`** — `RLMMetrics` object:

| Field                  | Description                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `modelCallCount`       | Total model calls including terminal call.                                            |
| `totalModelDurationMs` | Cumulative adapter duration.                                                          |
| `totalToolDurationMs`  | Cumulative tool execution duration.                                                   |
| `charsRead`            | Estimated characters returned by read tools (`slice`, `peek`, `summarize`, `query`).  |
| `coverageRatio`        | `charsRead / corpus.charCount`, capped at 1.0.                                        |
| `peekFirst`            | `true` when `peek` was the first retrieval tool (best-practice indicator).            |
| `synthesisTriggered`   | `true` when `max_iterations` was hit and a synthesis call was made.                   |
| `toolFrequency`        | `{ peek: 1, grep: 2, slice: 3 }` — count per retrieval tool; terminal tools excluded. |

**`result.sourcesUsed`** — `SourceRange[]` array of line ranges that were actually read. Only text-reading tools are included (`slice`, `summarize`, `query`, `peek`). Intermediate tools (`grep`, `search`) return line numbers but don't read text, so they are excluded.

```ts
for (const src of result.sourcesUsed) {
  console.log(
    `${src.tool} read lines ${src.startLine}–${src.endLine} (iteration ${src.iteration})`,
  );
}
// peek read lines 1–34 (iteration 1)
// slice read lines 5–7 (iteration 3)
```

---

## `formatTrace` — human-readable output

`formatTrace(trace: RLMTrace): string` renders a complete trace as a multi-line ASCII block. Suitable for `console.log`, structured log files, or a `<pre>` element.

```ts
import { formatTrace } from '@tkottke90/rlm';
import type { RLMLogger } from '@tkottke90/rlm';

const logger: RLMLogger = {
  onTrace(trace) {
    console.log(formatTrace(trace));
  },
};
```

Example output for a 4-iteration run:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RLM Trace  3a4f8c2d-1e2b-4f6a-9c8d-7b3e5f1a2c4d
2026-07-07T20:00:00.000Z  →  2026-07-07T20:00:04.832Z  (4,832ms)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Query:   "Who is the lead engineer on DataBridge?"
Corpus:  user-wiki  (1,234 chars / 20 lines)
Model:   qwen3:8b   Iterations: 4/10   Terminated: final_tool
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] Orientation                                    1,203ms model
    → peek(chars=500)                                  12ms tool
    ← "# User Wiki\n## People\n\n### Marcus Del…"

[2] Searching                                        987ms model
    → grep(pattern="Marcus")                            3ms tool
    ← "line 5: ### Marcus Delacroix\nline 6: Mar…"

[3] Reading                                          834ms model
    → slice(startLine=5, endLine=7)                     2ms tool
    ← "5: ### Marcus Delacroix\n6: Marcus is the…"

[4] Answer                                           743ms model

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Result:  FOUND  (final_tool)

  Marcus Delacroix is the lead engineer on the DataBridge project.

Sources: lines 1–9  (peek, iter 1)   lines 5–7  (slice, iter 3)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Metrics:
  model calls: 4  (3,767ms total)     tool calls: 3  (17ms total)
  chars read: 487 / 1,234  (39.47%)   peekFirst: yes
  tool usage: peek: 1   grep: 1   slice: 1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

When `max_iterations` fires, a synthesis block appears between the last iteration and the result:

```
─────────────────────────────────────────────────────────
Synthesis (1,204ms)
    Based on the sections reviewed, the answer is...
```

If the model emitted tool-call syntax during synthesis (despite tools being suppressed), the block notes `⚠ tool-call escape detected, retried`.

---

## Standalone utilities

`deriveSourcesUsed` and `deriveMetrics` are exported as standalone functions. Call them on any saved event array — useful for reprocessing stored logs without re-running the query.

```ts
import { deriveSourcesUsed, deriveMetrics } from '@tkottke90/rlm';

const events = JSON.parse(readFileSync('./run-log.json', 'utf8'));
const corpusMeta = { charCount: 12000, lineCount: 180, hasEmbeddings: false, hasProvenance: false };

const sources = deriveSourcesUsed(events);
const metrics = deriveMetrics(events, corpusMeta);
```

---

## Persisting traces

`RLMTrace` is fully JSON-serializable — no functions, no circular references, no class instances. Persist it directly:

```ts
const logger: RLMLogger = {
  onTrace(trace) {
    const line = JSON.stringify(trace) + '\n';
    appendFileSync('./traces.jsonl', line, 'utf8');
  },
};
```

Reload and render later:

```ts
const trace = JSON.parse(readFileSync('./trace.json', 'utf8'));
console.log(formatTrace(trace));
```
