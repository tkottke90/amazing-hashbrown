## Cost Rates Configuration

Cost rates tell amazing-hashbrown how much each model charges per token, so it can convert raw token counts into dollar amounts.

### Overview

Token counts are always recorded — the cost rates section just adds the pricing layer on top. Without it, the usage API returns accurate token counts but shows `$0` for cost. With it, costs are computed and displayed for every LLM call, including background AfterAgent runs.

### Configuration Section

Cost rates live under the `costs` key in `config.yaml`. The structure is:

```
costs:
  <provider-name>:
    <model-id>:
      input: <price per 1,000 input tokens in USD>
      output: <price per 1,000 output tokens in USD>
```

### Example

```yaml
costs:
  anthropic:
    claude-sonnet-4-6:
      input: 0.003
      output: 0.015
  openai:
    gpt-4.1-mini:
      input: 0.00015
      output: 0.0006
  local:
    llama3.1:
      input: 0.0
      output: 0.0
```

The provider name must match the `name` field of an entry in your `providers` list. Local models like Ollama can be given zero-cost rates if you want them to appear in cost reports without inflating your totals.

### Retroactive Recalculation

Costs are computed at query time from the stored token counts and your current `costs` config. This means:

- Updating a price retroactively re-calculates all historical costs for that model.
- You do not need to re-run any conversations — just update the rate and query again.

### Viewing Costs

After configuring rates, cost data is available via the Usage API (`GET /api/v1/usage`). The endpoint supports filtering by date range, provider, and model. See [[Cost Tracking]] for details on reading and interpreting that data.

### Tips

- Check the model provider's documentation for current pricing. Prices change, and you'll want to keep your rates up to date for accurate reporting.
- If you use the RLM with a separate model, make sure to add a cost entry for that model too — RLM token usage is tracked separately with its own model attribution. See [[Retrieval Loop Model (RLM) Configuration]].
