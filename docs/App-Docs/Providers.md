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

| Field            | Type   | Description                                                                                          |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `name`           | string | **Required.** Unique identifier used to reference this provider.                                     |
| `type`           | string | **Required.** Inference engine: `ollama`, `openai`, or `anthropic`.                                  |
| `baseUrl`        | string | Base URL for the API. Required for `ollama`; ignored by `openai`/`anthropic`.                        |
| `apiKey`         | string | API secret key. Required for `openai` and `anthropic`.                                               |
| `defaultModel`   | string | Model to use when no override is specified. Required if no per-request model is passed.              |
| `maxConcurrency` | number | Concurrent request slots this provider allows (`-1` = unlimited). Defaults to `1`.                   |
| `timeoutMs`      | number | Bounds a single outbound LLM HTTP call. Not wired for `ollama`.                                      |
| `temperature`    | number | Default sampling temperature for every model on this provider with no override of its own.           |
| `topP`           | number | Default nucleus-sampling value, same fallback behavior as `temperature`.                             |
| `seed`           | number | Default seed. Only forwarded for `ollama`/`openai`-type providers — Anthropic has no seed parameter. |
| `numCtx`         | number | Default Ollama context window size, in tokens. **Ollama-only.**                                      |
| `topK`           | number | Default Ollama top-k sampling value. **Ollama-only.**                                                |
| `repeatPenalty`  | number | Default Ollama repeat penalty. **Ollama-only.**                                                      |
| `models`         | array  | Per-model pricing and sampling overrides — see [`models[]`](#models) below.                          |

## `models[]`

Each provider can list specific models to set their own pricing and/or sampling settings,
overriding that provider's own defaults above. This matters because a provider often serves
several models that disagree about what good settings are — for example, OpenAI recommends
`temperature: 1` for its `gpt-oss` models, while other models on the same Ollama server may do
better at `temperature: 0`. A model's own value always wins; if it leaves a field unset, that
provider's own value (if any) is used; if neither is set, the underlying client's own default
applies — identical to today's behavior for a provider with no sampling config at all.

`id` matches a requested model name by **exact string equality only** — no prefix or glob
matching. A provider with several tagged variants of the same base model (e.g. `gpt-oss:20b` and
`gpt-oss:120b`) needs a separate entry for each.

| Field             | Type   | Description                                                                                                                       |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string | **Required.** Exact model id, matched verbatim against the requested model.                                                       |
| `inputPricePerM`  | number | USD price per 1,000,000 input tokens, used for the model picker's price display, cost estimates, and the Settings UI cost editor. |
| `outputPricePerM` | number | USD price per 1,000,000 output tokens.                                                                                            |
| `temperature`     | number | Overrides the provider's `temperature` for this model only.                                                                       |
| `topP`            | number | Overrides the provider's `topP` for this model only.                                                                              |
| `seed`            | number | Overrides the provider's `seed` for this model only. Ignored for Anthropic.                                                       |
| `numCtx`          | number | Overrides the provider's `numCtx` for this model only. **Ollama-only.**                                                           |
| `topK`            | number | Overrides the provider's `topK` for this model only. **Ollama-only.**                                                             |
| `repeatPenalty`   | number | Overrides the provider's `repeatPenalty` for this model only. **Ollama-only.**                                                    |

```yaml
providers:
  - name: local
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3
    # Applies to every model on this provider unless a models[] entry below overrides it.
    temperature: 0
    models:
      - id: gpt-oss:20b
        temperature: 1 # OpenAI's own recommendation for this model
        numCtx: 16384 # Ollama's default context size is chosen by GPU memory, not this model's needs
      - id: llama3
        inputPricePerM: 0
        outputPricePerM: 0
  - name: anthropic
    type: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    defaultModel: claude-sonnet-4-6
    models:
      - id: claude-sonnet-4-6
        inputPricePerM: 3
        outputPricePerM: 15
```

An invalid value on a `models[]` entry (e.g. a non-numeric `temperature`) only drops that one
entry — logged at startup naming the provider and model — rather than failing the whole
`providers` list; the same applies to a malformed provider entry itself, which only drops that
provider.

This also replaces the top-level `costs:` setting as the source for pricing — see
[Cost Rates](./configuration.md#cost-rates) in the configuration reference for migrating
existing `costs:` entries.

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
    models:
      - id: claude-sonnet-4-6
        inputPricePerM: 3
        outputPricePerM: 15

defaultProvider: local

favoriteModels:
  - provider: openai
    model: gpt-4.1-mini
```

Multiple providers can be defined simultaneously. The `defaultProvider` field controls
which one the chat agent uses at startup.
