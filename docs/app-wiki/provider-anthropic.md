# Anthropic Provider

The Anthropic provider connects amazing-hashbrown to Claude models via Anthropic's API. Claude models are well-suited to long-context tasks, nuanced instruction-following, and agentic workflows.

## Configuration

Set `type: anthropic` in your provider entry inside `config.yaml`.

```yaml
providers:
  - name: anthropic
    type: anthropic
    apiKey: sk-ant-...
    defaultModel: claude-sonnet-4-6
```

### Required fields

- `name` — an arbitrary label shown in the UI.
- `apiKey` — your Anthropic API key, starting with `sk-ant-`. Store it via the Settings UI or an environment variable rather than committing it to version control.

### Optional fields

- `defaultModel` — the Claude model pre-selected for new conversations. Examples: `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. If omitted, the first model returned by Anthropic's models endpoint is used.

No `baseUrl` override is needed for the standard Anthropic API.

## Available models

The provider fetches the model list from Anthropic's models endpoint at runtime. Any model your API key has access to will appear in the model switcher.

## Extended thinking (reasoning tokens)

Claude models that support extended thinking will show a collapsible **"Thought process"** block in the conversation view when the model reasons through a problem before responding. This is rendered automatically — no extra configuration required. The thinking tokens are displayed for transparency but do not count against the visible response.

## Tracking spend

Add a `costs` block to log per-model pricing and display a spend estimate:

```yaml
providers:
  - name: anthropic
    type: anthropic
    apiKey: sk-ant-...
    costs:
      claude-sonnet-4-6:
        input: 3.00 # USD per million tokens
        output: 15.00
      claude-haiku-4-5-20251001:
        input: 0.80
        output: 4.00
```

See [[Cost Rates Configuration]] for full details on the `costs` schema and how spend is tracked across providers.
