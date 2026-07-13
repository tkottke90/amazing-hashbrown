# API Reference

## `ObservabilityStore`

The main class. Owns the SQLite database connection and all read/write operations. Import from `@tkottke90/observability`.

### `ObservabilityStore.open(dbPath: string): ObservabilityStore`

Opens (or creates) the SQLite database at `dbPath` and applies any pending schema migrations. Safe to call on every startup — migrations are idempotent.

```typescript
const store = ObservabilityStore.open('./config/app.db');
```

### `store.startTrace(params: StartTraceParams): string`

Creates a new trace row. Returns the `traceId`. Call this before running the agent for a turn.

```typescript
interface StartTraceParams {
  threadId?: string; // The conversation thread this trace belongs to
  taskId?: string; // Optional task identifier
  provider: string; // e.g. 'openai', 'anthropic'
  model: string; // e.g. 'gpt-4o', 'claude-3-5-sonnet'
}
```

### `store.endTrace(traceId: string, params: EndTraceParams): void`

Closes the trace with final token counts and optional cost estimate. Call this after the agent turn completes.

```typescript
interface EndTraceParams {
  totalTokens: number;
  totalCostEstimate?: number; // In USD; omit if not available
}
```

### `store.saveSpans(spans: SpanRecord[]): void`

Bulk-inserts all spans for a turn in a single database transaction. Call this after the agent finishes (the `ObservabilityCallbackHandler` does this automatically via `handleChainEnd`). A no-op if the array is empty.

### `store.findById(traceId: string): TraceSummary | null`

Returns the metrics summary for a single trace, or `null` if not found. Does not include span content.

### `store.list(filters?: TraceFilters): TraceSummary[]`

Returns a list of trace summaries, newest first.

```typescript
interface TraceFilters {
  threadId?: string; // Return only traces for this thread
  taskId?: string; // Return only traces for this task
  since?: string; // ISO 8601 date; return traces where startedAt >= since
  limit?: number; // Default: 50
  offset?: number; // Default: 0
}
```

### `store.getTrace(traceId: string): TraceWithSpans | null`

Returns the full trace including all spans, or `null` if not found. Spans are ordered by `startedAt` ascending.

### `store.close(): void`

Closes the database connection. Call during graceful shutdown.

---

## `buildSpanTree(spans: SpanRecord[]): SpanNode[]`

Converts a flat `SpanRecord[]` (as returned by `getTrace().spans`) into a tree where each `llm-call` span has its `tool-call` children nested under `children`. Import from `@tkottke90/observability`.

A span whose `parentSpanId` is not found in the input list is treated as a root node.

---

## Types

All types are exported from both `@tkottke90/observability` and `@tkottke90/llm-common-types/traces`.

### `SpanRecord`

| Field           | Type                        | Description                                                                                                                                            |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spanId`        | `string`                    | Unique identifier for this span (LangChain run ID)                                                                                                     |
| `traceId`       | `string`                    | The trace this span belongs to                                                                                                                         |
| `parentSpanId`  | `string \| null`            | For `tool-call` spans: the `spanId` of the `llm-call` that triggered them. `null` for `llm-call` spans.                                                |
| `type`          | `'llm-call' \| 'tool-call'` | The kind of operation                                                                                                                                  |
| `name`          | `string`                    | Model name for `llm-call`; tool name for `tool-call`                                                                                                   |
| `startedAt`     | `string`                    | ISO 8601 timestamp                                                                                                                                     |
| `endedAt`       | `string \| null`            | ISO 8601 timestamp; `null` if the span errored before completing                                                                                       |
| `latencyMs`     | `number \| null`            | Wall-clock time in milliseconds                                                                                                                        |
| `inputTokens`   | `number \| null`            | `llm-call` only: prompt tokens                                                                                                                         |
| `outputTokens`  | `number \| null`            | `llm-call` only: completion tokens                                                                                                                     |
| `outputPreview` | `string \| null`            | `llm-call`: JSON array of tool calls the model decided to make; `tool-call`: first N chars of the tool result (controlled by `spanOutputPreviewChars`) |
| `inputPreview`  | `string \| null`            | `tool-call`: full tool arguments JSON; `llm-call`: always `null` (input is in the checkpoint)                                                          |
| `error`         | `string \| null`            | Error message if the operation failed                                                                                                                  |

### `TraceSummary`

Metrics-only shape, returned by `findById()` and `list()`.

| Field               | Type             | Description                                       |
| ------------------- | ---------------- | ------------------------------------------------- |
| `traceId`           | `string`         | Unique identifier                                 |
| `threadId`          | `string \| null` | The conversation thread                           |
| `taskId`            | `string \| null` | The task, if any                                  |
| `provider`          | `string`         | e.g. `'openai'`                                   |
| `model`             | `string`         | e.g. `'gpt-4o'`                                   |
| `startedAt`         | `string`         | ISO 8601 timestamp                                |
| `endedAt`           | `string \| null` | ISO 8601 timestamp; `null` for in-progress traces |
| `totalTokens`       | `number`         | Sum of all input and output tokens in this trace  |
| `totalCostEstimate` | `number \| null` | Estimated cost in USD                             |
| `spanCount`         | `number`         | Total number of spans                             |
| `llmCallCount`      | `number`         | Number of `llm-call` spans                        |
| `toolCallCount`     | `number`         | Number of `tool-call` spans                       |

### `TraceWithSpans`

Full detail shape, returned by `getTrace()`.

Contains all fields from `TraceSummary` (except `spanCount`, `llmCallCount`, `toolCallCount`) plus:

| Field   | Type           | Description                                                |
| ------- | -------------- | ---------------------------------------------------------- |
| `spans` | `SpanRecord[]` | All spans for this trace, ordered by `startedAt` ascending |

### `SpanNode`

Returned by `buildSpanTree()`. Extends `SpanRecord` with one additional field:

| Field      | Type         | Description                                         |
| ---------- | ------------ | --------------------------------------------------- |
| `children` | `SpanNode[]` | Child spans (tool calls triggered by this llm-call) |

### Zod schemas

All schemas are exported for validation at runtime:

- `SpanTypeSchema`
- `SpanRecordSchema`
- `TraceRecordSchema`
- `TraceSummarySchema`
- `TraceWithSpansSchema`
