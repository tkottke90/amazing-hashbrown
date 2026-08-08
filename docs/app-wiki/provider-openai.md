# OpenAI Provider

The OpenAI provider connects amazing-hashbrown to OpenAI's API, giving you access to the GPT family of models including `gpt-4.1-mini`, `gpt-4o`, and others.

## Configuration

Set `type: openai` in your provider entry inside `config.yaml`.

```yaml
providers:
  - name: openai
    type: openai
    apiKey: sk-...
    defaultModel: gpt-4.1-mini
```

### Required fields

- `name` — an arbitrary label shown in the UI.
- `apiKey` — your OpenAI secret key, starting with `sk-`. Keep this out of version control; use an environment variable or the Settings UI to set it safely.

### Optional fields

- `defaultModel` — the model pre-selected for new conversations (e.g. `gpt-4.1-mini`, `gpt-4o`). If omitted, the app will use the first model returned by OpenAI's models endpoint.
- `baseUrl` — override the endpoint URL. Leave this unset to use the standard OpenAI API. See the section below on compatible endpoints.

## Available models

The provider fetches the list of available models from OpenAI's models endpoint at runtime, so newly released models appear without any app update.

## Tracking spend

Add a `costs` block to your provider config to record per-model pricing. The app will display a running spend estimate in the conversation header.

```yaml
providers:
  - name: openai
    type: openai
    apiKey: sk-...
    costs:
      gpt-4o:
        input: 2.50 # USD per million tokens
        output: 10.00
      gpt-4.1-mini:
        input: 0.15
        output: 0.60
```

## OpenAI-compatible endpoints

The `type: openai` adapter works with any server that exposes an OpenAI-compatible chat completions API. Set a custom `baseUrl` to point at your local inference server or third-party provider:

```yaml
providers:
  - name: local-inference
    type: openai
    baseUrl: http://localhost:8080/v1
    apiKey: ignored # some servers require a placeholder
    defaultModel: my-model
```

This is useful for running open-weight models through tools like LM Studio, vLLM, or llama.cpp with an OpenAI-compatible frontend.
