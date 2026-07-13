# @tkottke90/observability

Records everything the AI agent does during a conversation — token counts, tool invocations, response previews, latency — so you can track costs, debug problems, and compare model performance over time.

## What it does NOT do

- Does not send data to any external service. All data is stored locally in a SQLite file.
- Does not hook into the LangChain runtime directly. The `ObservabilityCallbackHandler` that captures live data lives in the API layer (`api/src/agents/`). This library is framework-agnostic and has no dependency on LangChain.
- Does not duplicate checkpoint data. The full message history lives in the LangGraph checkpoint; spans store only what the checkpoint omits (timing, token counts, tool call arguments, response previews).

## Quick start

```typescript
import { ObservabilityStore, buildSpanTree } from '@tkottke90/observability';

// Open (or create) the database. Safe to call on every startup.
const store = ObservabilityStore.open('./config/app.db');

// Retrieve a full trace with all its spans
const trace = store.getTrace('some-trace-id');
if (trace) {
  // Flat list of spans in chronological order
  console.log(trace.spans);

  // Or as a tree where tool-call spans are nested under the llm-call that triggered them
  const tree = buildSpanTree(trace.spans);
  console.log(tree);
}

// List recent traces for a thread (metrics only — no content)
const summaries = store.list({ threadId: 'thread-abc', limit: 20 });
```

## Documentation

| File                                               | Contents                                          |
| -------------------------------------------------- | ------------------------------------------------- |
| [docs/getting-started.md](docs/getting-started.md) | Concepts, data capture flow, and query examples   |
| [docs/api-reference.md](docs/api-reference.md)     | Full method signatures and type field tables      |
| [docs/configuration.md](docs/configuration.md)     | The `observability:` config block, field by field |
