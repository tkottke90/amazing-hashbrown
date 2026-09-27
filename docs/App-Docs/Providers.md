# LLM Providers

The application routes all chat traffic through a configurable LLM provider.
At least one provider must be defined in `config/config.yaml` for the chat agent to start.

## Supported Inference Engines

| Engine                                 | `type` value | Requires `baseUrl` | Requires `apiKey`          |
| -------------------------------------- | ------------ | ------------------ | -------------------------- |
| [Ollama](https://ollama.com)           | `ollama`     | Yes                | No (optional bearer token) |
| [OpenAI](https://platform.openai.com)  | `openai`     | No                 | Yes                        |
| [Anthropic](https://www.anthropic.com) | `anthropic`  | No                 | Yes                        |

### Ollama

Self-hosted, runs models locally. No API key is needed for a default Ollama installation.
Set `baseUrl` to the address where your Ollama server is listening.

```yaml
providers:
  - name: local
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3
```

### OpenAI

Calls the OpenAI API. The `apiKey` value should be an `sk-…` secret from your
[OpenAI dashboard](https://platform.openai.com/api-keys). Use `${ENV_VAR}` syntax
to pull it from an environment variable instead of storing it in the file.

```yaml
providers:
  - name: openai
    type: openai
    apiKey: ${OPENAI_API_KEY}
    defaultModel: gpt-4.1-mini
```

### Anthropic

Calls the Anthropic API. The `apiKey` value should be an `sk-ant-…` secret from your
[Anthropic Console](https://console.anthropic.com/settings/keys).

```yaml
providers:
  - name: anthropic
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    defaultModel: claude-sonnet-4-6
```

## Configuration Reference

All providers share the same schema. Fields marked **required** must be present for that provider type.

| Field          | Type   | Description                                                                             |
| -------------- | ------ | --------------------------------------------------------------------------------------- |
| `name`         | string | **Required.** Unique identifier used to reference this provider.                        |
| `type`         | string | **Required.** Inference engine: `ollama`, `openai`, or `anthropic`.                     |
| `baseUrl`      | string | Base URL for the API. Required for `ollama`; ignored by `openai`/`anthropic`.           |
| `apiKey`       | string | API secret key. Required for `openai` and `anthropic`.                                  |
| `defaultModel` | string | Model to use when no override is specified. Required if no per-request model is passed. |

### `defaultProvider`

Set `defaultProvider` to the `name` of whichever provider should handle requests that do not
specify one. If omitted, the first entry in the `providers` list is used.

```yaml
defaultProvider: local
```

### `favoriteModels`

An ordered list of provider/model pairs pinned to the top of the chat input's **Provider**
menu, as a flat **Favorites** section. This is most useful for router providers — a single
endpoint that proxies to dozens of models (e.g. DigitalOcean Serverless Inference) — where
drilling into the provider's full model list every time is slow.

| Field      | Type   | Description                                            |
| ---------- | ------ | ------------------------------------------------------ |
| `provider` | string | **Required.** The `name` of a provider in `providers`. |
| `model`    | string | **Required.** A model id that provider lists.          |

```yaml
favoriteModels:
  - provider: do-serverless
    model: llama3.3-70b-instruct
  - provider: local
    model: qwen3:14b
```

Favorites can also be managed on **Settings → Model providers → Favorites**, which writes the
same key back to `config.yaml`. When the list is empty, the chat menu shows no Favorites
section at all.

**Stale entries.** Favorites are never removed automatically:

- A favorite whose model is not in the provider's current model list (e.g. a model a router
  provider retired, or a provider that is temporarily unreachable) is hidden from the chat
  menu and marked **Unavailable** in Settings.
- Saving the Model providers settings rejects any favorite whose `provider` does not match a
  configured provider's `name` — remove the entry (it shows as Unavailable) to save.
- A malformed entry in `config.yaml` (e.g. missing `model`) is ignored; the other entries
  still load.

## Full Example

```yaml
providers:
  - name: local
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3
  - name: openai
    type: openai
    apiKey: ${OPENAI_API_KEY}
    defaultModel: gpt-4.1-mini
  - name: anthropic
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    defaultModel: claude-sonnet-4-6

defaultProvider: local

favoriteModels:
  - provider: openai
    model: gpt-4.1-mini
```

Multiple providers can be defined simultaneously. The `defaultProvider` field controls
which one the chat agent uses at startup.
