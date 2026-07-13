# Getting Started

## What this library does

Every time the AI agent responds to a user message, it makes one or more calls to a language model and potentially calls tools (like a web search or a calculator). This library records all of that activity as structured data stored in a local SQLite database. The result is a complete audit log that lets you:

- See how many tokens each conversation consumed and estimate costs
- Identify which tool calls the agent made and what it received back
- Measure how long each model call and tool call took
- Compare what the agent did across different conversations or model versions

## Core concepts

**Trace** — a record that represents a single conversation turn. Think of it as a receipt for one round-trip with the agent: it records which model was used, when the turn started and ended, and the total token count.

**Span** — a single step inside a turn. Think of it as a line item on that receipt. There are two kinds:

- `llm-call` — one call to the language model. Records timing, token counts, and a preview of what the model decided to do (for example, which tools it chose to call).
- `tool-call` — one tool invocation triggered by the model. Records the tool name, its input arguments, a preview of the result, and timing. A tool-call span is a "child" of the llm-call span that triggered it.

Each span belongs to a trace via `traceId`, and tool-call spans reference their parent llm-call via `parentSpanId`.

## How data is captured

A callback hook in the API (`api/src/agents/observability-handler.ts`) fires automatically when the agent processes a turn. You do not need to change any agent logic. The flow is:

1. Before the agent runs, `store.startTrace()` creates a trace row.
2. While the agent runs, the hook collects timing and token data for each model call and tool call in memory.
3. After the agent finishes, `store.saveSpans()` writes all spans in a single database transaction and `store.endTrace()` closes the trace with the final token total.

Because writes happen after the turn completes, there is no performance impact on the agent's response time.

## Querying traces

### List traces for a thread (metrics only)

```typescript
import { ObservabilityStore } from '@tkottke90/observability';

const store = ObservabilityStore.open('./config/app.db');

const summaries = store.list({ threadId: 'thread-abc', limit: 20 });
// summaries: TraceSummary[]
// Each entry has: traceId, threadId, provider, model, startedAt, endedAt,
//                 totalTokens, totalCostEstimate, spanCount, llmCallCount, toolCallCount
```

Use `list()` when you need to display a conversation history, build a cost dashboard, or aggregate token usage. It returns only numbers and timestamps — no content — so it stays fast even with many traces.

### Fetch a single trace overview

```typescript
const summary = store.findById('some-trace-id');
// summary: TraceSummary | null
```

### Fetch the full trace with all spans

```typescript
const trace = store.getTrace('some-trace-id');
// trace: TraceWithSpans | null
// trace.spans is a flat array of SpanRecord, ordered by startedAt ascending
```

Use `getTrace()` when you need to inspect what the agent did step by step — for debugging, for automated evaluation, or for a detail view.

### Build a span tree

```typescript
import { buildSpanTree } from '@tkottke90/observability';

const tree = buildSpanTree(trace.spans);
// tree: SpanNode[]
// Each SpanNode is a SpanRecord with an added `children: SpanNode[]` field.
// tool-call spans appear as children of the llm-call span that triggered them.
```

Use `buildSpanTree()` when you want to traverse the agent's decision process in order — first the model decides, then the tools run, then the model decides again.

## What is and isn't stored

The `spanOutputPreviewChars` setting (default: 500) controls how much text is saved per span:

| Setting | Behavior |
|---------|----------|
| `500` (default) | First 500 characters of the model response and each tool result |
| `-1` | Full text stored (higher fidelity, uses more disk space) |
| `0` | No text stored (metrics-only mode: tokens, latency, cost only) |

**What is always omitted**: the full message history that the model received as input. That data already lives in the LangGraph checkpoint and is not duplicated here. Spans store the *output* of each step, not the *input*.

**Tool call arguments** are always stored in full (in `inputPreview`) regardless of `spanOutputPreviewChars`. Tool arguments are small (a few hundred bytes at most) and represent a key behavioral record — what the agent decided to do — so they are never truncated.
