## Cost Tracking

amazing-hashbrown records every LLM call's token usage in SQLite, giving you a running ledger of how much inference you have consumed — and how much it cost.

### What Is Tracked

Every inference call — whether from a foreground chat turn or a background AfterAgent run — generates a trace entry that includes:

- **Input token count** — tokens in the prompt sent to the model.
- **Output token count** — tokens in the model's response.
- **Provider and model** — which backend and model served the call.
- **Timestamp and latency** — when the call happened and how long it took.

This covers all model activity: the main chat agent, the AfterAgent pipeline, the RLM retrieval loop, and any tool calls that involve model inference.

### Adding Dollar Amounts

By default, token counts are recorded but costs show as `$0` because no pricing is configured. To see dollar amounts, add per-model rates to `config.yaml` under the `costs` section. See [[Cost Rates Configuration]] for the exact format.

Once rates are configured, dollar amounts are computed at query time — updating a price retroactively re-calculates all historical costs without any data migration.

### Querying Usage Data

Token and cost data is accessible via the Usage API:

```
GET /api/v1/usage
```

The endpoint accepts query parameters to filter the results:

| Parameter | Description |
|---|---|
| `from` | Start date (ISO 8601, e.g. `2026-01-01`) |
| `to` | End date (ISO 8601) |
| `provider` | Filter by provider name |
| `model` | Filter by model ID |

The response includes aggregated totals and a per-model breakdown.

### Separating Chat and Background Costs

AfterAgent background runs are tagged differently from foreground chat turns in the trace store (see [[Observability Configuration]]). The usage API will reflect this distinction, so you can compare how much inference is consumed by your conversations versus the automatic wiki-building pipeline.

### Keeping Costs Low

A few strategies:

- Use a local Ollama model for the RLM loop (fast, cheap background retrieval) and a cloud model for main chat. See [[Retrieval Loop Model (RLM) Configuration]].
- Set `afterAgent.enabled: false` to stop background inference entirely when experimenting. See [[AfterAgent Configuration]].
- Reduce `observability.spanOutputPreviewChars` if you need to reduce storage, though this does not affect token costs — only how much is stored per span.
