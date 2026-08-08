## How to Add a Provider

A provider is an LLM backend that amazing-hashbrown sends inference requests to. You can add and manage providers through the Settings UI or by editing `config.yaml` directly.

### Adding via the Settings UI

1. Open the app in your browser and go to **Settings → Model Providers**.
2. Click **Add Provider**.
3. Choose the provider type, fill in the required fields, and save.

Changes take effect immediately — no restart required.

### Adding via config.yaml

Open `./data/config.yaml` and add entries to the `providers` list. Examples for each supported type are below.

#### Ollama (local, no API key)

```yaml
providers:
  - name: local
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3.1
```

See [[How to Set Up Ollama]] for full Ollama setup instructions.

#### OpenAI

```yaml
providers:
  - name: openai
    type: openai
    apiKey: sk-...
    defaultModel: gpt-4.1-mini
```

#### Anthropic

```yaml
providers:
  - name: anthropic
    type: anthropic
    apiKey: sk-ant-...
    defaultModel: claude-sonnet-4-6
```

Any `config.yaml` string value can reference an environment variable:

```yaml
apiKey: ${ANTHROPIC_API_KEY}
```

### Selecting the Default Provider

The `defaultProvider` key controls which provider is used for new chat threads:

```yaml
defaultProvider: anthropic
```

The value must match a `name` in your `providers` list. You can also change this from **Settings → General**.

### Using Multiple Providers

You can have as many providers as you like. They can all coexist — for example, one local Ollama provider for fast queries and one Anthropic provider for complex reasoning. Users can switch providers per-thread from the model selector in the chat panel. See [[How to Switch Models in a Conversation]].

### Optional: Per-Model Pricing

Each provider can include a `models` list with pricing information for cost tracking. This is optional — without it, token counts are still recorded but dollar amounts are not computed.

```yaml
providers:
  - name: anthropic
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    defaultModel: claude-sonnet-4-6
    models:
      - id: claude-sonnet-4-6
        inputPricePer1k: 0.003
        outputPricePer1k: 0.015
```

See [[Cost Rates Configuration]] and [[Cost Tracking]] for more detail.
