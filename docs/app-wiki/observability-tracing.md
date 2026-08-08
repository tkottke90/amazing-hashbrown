# Observability Tracing

amazing-hashbrown records every LLM call, tool invocation, token count, and latency as **structured traces** in SQLite. This gives you a complete audit trail of agent behavior — useful for understanding why the agent made a particular decision, diagnosing slow turns, or tracking costs.

## Trace Structure

Traces are organized as a **tree**:

- Each **chat turn** is one top-level trace
- Each **reasoning step**, **tool call**, and **model invocation** is a child span under that trace
- [[AfterAgent Pipeline]] background runs create their own top-level traces, tagged with an `after-agent:` prefix so they're easy to distinguish from interactive turns

## What Each Span Stores

| Field | Description |
|---|---|
| Start / end timestamps | When the span began and completed |
| Input | The input passed to the model or tool |
| Output preview | A truncated preview of the output (length configurable) |
| Token counts | Prompt tokens, completion tokens, and total |
| Errors | Any exception or failure message |

## Configuring Output Preview Length

The `observability.spanOutputPreviewChars` setting controls how much output is stored per span:

```yaml
observability:
  spanOutputPreviewChars: 500   # default — compact preview
```

- Set to `-1` to store **full output** — useful for deep debugging but grows the database quickly
- Set to `0` to store **metrics only** (timestamps and token counts, no content) — smallest footprint

## Accessing Traces

Traces are available via the REST API:

```
GET /api/v1/traces
```

This endpoint is intended for integration with external observability tools or custom dashboards. See [[Observability Configuration]] for all settings and [[Cost Tracking]] for per-model cost aggregation derived from these traces.
