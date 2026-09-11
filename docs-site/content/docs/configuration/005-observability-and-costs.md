---
title: Observability & Costs
section: Configuration
order: 6
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Observability & Costs

Two related settings: how much detail gets recorded about what the agent did, and how that activity gets priced when estimating spend.

### Observability

Controls agent tracing — token counts, latency, and tool-call records — written to the app's shared SQLite database.

| Key                      | Type    | Default | Description                                                                                                                                          |
| ------------------------ | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                | boolean | `true`  | Whether tracing is recorded at all.                                                                                                                    |
| `spanOutputPreviewChars` | number  | `500`   | Characters of each LLM response / tool result stored per span. `-1` stores the full content; `0` stores none (metrics-only: tokens, latency, cost).    |

{% call code(language="yaml") %}
observability:
  enabled: true
  spanOutputPreviewChars: 500
{% endcall %}

### Costs

Optional. Maps a `"providerName/model"` key — where `providerName` matches a `name` under `providers` — to a per-1,000-token USD price, used to estimate spend in observability data. Omitting a pair treats it as free, which is typically fine for local/Ollama models.

| Key                 | Type         | Default | Description                                                                                    |
| ------------------- | ------------ | ------- | ------------------------------------------------------------------------------------------------ |
| `inputPer1kTokens`  | number       | `0`     | USD price per 1,000 input tokens, always normalized to this unit regardless of `inputScale`.     |
| `inputScale`        | `1k` \| `1M` | `1k`    | UI-only metadata recording which unit the value was entered in. Doesn't affect the calculation.  |
| `outputPer1kTokens` | number       | `0`     | USD price per 1,000 output tokens, always normalized to this unit regardless of `outputScale`.   |
| `outputScale`       | `1k` \| `1M` | `1k`    | UI-only metadata recording which unit the value was entered in. Doesn't affect the calculation.  |

{% call code(language="yaml") %}
costs:
  anthropic/claude-sonnet-4-6:
    inputPer1kTokens: 0.003
    outputPer1kTokens: 0.015
  openai/gpt-4.1-mini:
    inputPer1kTokens: 0.0004
    outputPer1kTokens: 0.0012
{% endcall %}

Rates are stored historically — changing a price doesn't rewrite past data. A span already recorded keeps the rate that was active when it ran.
