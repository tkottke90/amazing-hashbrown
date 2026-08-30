# Configuration

The API is configured through a single YAML file, `config/config.yaml`, plus a small number of
environment variables. This page documents every option the schema in `api/src/config/env.ts`
supports today.

## The Config File

- **Location**: resolved by [`@tkottke90/config-manager`](https://www.npmjs.com/package/@tkottke90/config-manager)
  in this order: the `CONFIG_DIR` environment variable, falling back to `./config` (relative to
  where the API process starts). `config.yaml` is appended automatically when the resolved path is
  a directory.
- **Auto-created**: if `config/config.yaml` does not exist, it is generated from the schema's
  defaults on first run. `config/` is gitignored — `api/config.yaml.example` is the committed
  reference copy; copy it to `config/config.yaml` and edit it for your environment.
- **Write-back**: this app runs with `writeBack: true`, so whenever a new option is added to the
  schema (e.g. after an upgrade), the missing field is filled in with its default and written back
  to your existing `config.yaml` automatically — you don't need to manually merge new options in.
- **Format**: YAML (`.yaml`/`.yml`) or JSON (`.json`), detected by file extension.

### Environment variable interpolation

Any string value in the file can reference an environment variable with `${UPPER_CASE}` syntax:

```yaml
providers:
  - name: openai
    type: openai
    apiKey: ${OPENAI_API_KEY}
```

`${OPENAI_API_KEY}` is replaced with `process.env.OPENAI_API_KEY` when the file is loaded — this is
the recommended way to keep secrets out of the committed/gitignored file itself. If the variable is
unset, it's substituted with an empty string and a warning is logged.

The API also loads a `.env` file from the process's working directory at startup (via `dotenv`), so
`OPENAI_API_KEY=sk-...` in a local `.env` file works the same as exporting it in your shell.

---

## Top-Level Options

| Key               | Type   | Default         | Description                                                                                               |
| ----------------- | ------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| `port`            | number | `3000`          | Port the API server listens on.                                                                           |
| `logLevel`        | string | `"info"`        | Log verbosity: `debug` \| `info` \| `warn` \| `error`.                                                    |
| `wikiRoot`        | string | `"./wiki"`      | Path to the knowledge-base root directory, resolved relative to the config directory.                     |
| `mcpConfigDir`    | string | `"./mcp"`       | Directory holding `mcp.json` (MCP server definitions) and other runtime config, resolved the same way.    |
| `artifactRoot`    | string | `"./artifacts"` | Directory where uploaded and agent-generated artifacts (images, files) are stored, resolved the same way. |
| `defaultProvider` | string | `""`            | The `name` of the provider used for requests that don't specify one. See [Providers](./Providers.md).     |
| `providers`       | array  | `[]`            | LLM provider definitions. See [Providers](./Providers.md) for the full schema and per-engine examples.    |
| `costs`           | object | `{}`            | Per-provider/model token pricing, keyed `"providerName/model"`. See [Cost Rates](#cost-rates).            |

```yaml
port: 3000
logLevel: info
wikiRoot: ./config/kb
mcpConfigDir: ./config
artifactRoot: ./config/artifacts
```

`providers`/`defaultProvider` are documented in full, with per-engine setup instructions, in
**[Providers.md](./Providers.md)** — this page only covers the sections below.

---

## `embeddings`

Powers semantic/hybrid ranking for the `wiki_search` tool. When disabled (or unreachable), wiki
search falls back to keyword-only matching — it degrades gracefully rather than erroring.

| Key       | Type    | Default                       | Description                                                      |
| --------- | ------- | ----------------------------- | ---------------------------------------------------------------- |
| `enabled` | boolean | `true`                        | Whether an embedding provider is constructed at all.             |
| `model`   | string  | `"nomic-embed-text"`          | Embedding model name.                                            |
| `baseUrl` | string  | `"http://localhost:11434/v1"` | Base URL of the (Ollama, OpenAI-compatible) embeddings endpoint. |

```yaml
embeddings:
  enabled: true
  model: nomic-embed-text
  baseUrl: http://localhost:11434/v1
```

Currently wired to a local Ollama instance only (`OllamaEmbeddingProvider`, no API key required) —
the same server your `ollama`-type chat provider typically points at.

---

## `database`

The shared SQLite database used by every feature that persists data — observability traces,
conversation threads, evaluations, cost tracking. All features share one file.

| Key    | Type   | Default    | Description                                                                                                                 |
| ------ | ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `path` | string | `"app.db"` | Path to the database file, resolved relative to the directory containing `config.yaml`. Use an absolute path in production. |

```yaml
database:
  path: app.db
```

Do not delete this file between restarts — it holds the entire application's persisted state.

---

## `observability`

Controls agent tracing: token counts, latency, and tool-call records, written to the shared
database above.

| Key                      | Type    | Default | Description                                                                                                                                                                                     |
| ------------------------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | boolean | `true`  | Whether tracing is recorded at all.                                                                                                                                                             |
| `spanOutputPreviewChars` | number  | `500`   | How many characters of each LLM response / tool result to store per span. `-1` stores the full content (high fidelity, higher disk use); `0` stores none (metrics-only: tokens, latency, cost). |

```yaml
observability:
  enabled: true
  spanOutputPreviewChars: 500
```

---

## `afterAgent`

The background post-response layer that inspects each conversational turn for novel knowledge and
writes it into the wiki. Runs after the turn's SSE stream has already completed — it never blocks
or slows down the user-facing response.

| Key       | Type    | Default | Description                          |
| --------- | ------- | ------- | ------------------------------------ |
| `enabled` | boolean | `true`  | Global kill switch for the pipeline. |

```yaml
afterAgent:
  enabled: true
```

This is a global switch — it can also be disabled per-request via the `afterAgent` field on
`POST /api/v1/chat/:threadId`, but the global switch always wins if it's `false`.

---

## `chat`

| Key                 | Type    | Default | Description                                                                                                                                                                                                           |
| ------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `showErrorMessages` | boolean | `false` | When `false`, a failed turn that has since been retried is hidden from conversation history — only the successful retry shows. A failed turn that hasn't been retried yet is always shown regardless of this setting. |

```yaml
chat:
  showErrorMessages: false
```

Overridable per-request via `GET /api/v1/threads/:id?showErrors=true`.

---

## Cost Rates

Optional. Maps `"providerName/model"` keys (where `providerName` matches a `name` in `providers[]`)
to per-1,000-token prices in USD, used to estimate spend in observability data. Omitting a
provider/model pair treats it as free (`$0`) — local/Ollama models can typically be omitted
entirely.

| Key                 | Type            | Default | Description                                                                                             |
| ------------------- | --------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `inputPer1kTokens`  | number          | `0`     | USD price per 1,000 input tokens — always normalized to this unit, regardless of `inputScale`.          |
| `inputScale`        | `1k` \| `1M`    | `1k`    | UI-only metadata recording which unit the value was entered in (so the Settings UI's toggle can restore it). Does not affect cost calculation. |
| `outputPer1kTokens` | number          | `0`     | USD price per 1,000 output tokens — always normalized to this unit, regardless of `outputScale`.        |
| `outputScale`       | `1k` \| `1M`    | `1k`    | UI-only metadata recording which unit the value was entered in. Does not affect cost calculation.       |

```yaml
costs:
  anthropic/claude-sonnet-4-6:
    inputPer1kTokens: 0.003
    outputPer1kTokens: 0.015
  openai/gpt-4.1-mini:
    inputPer1kTokens: 0.0004
    outputPer1kTokens: 0.0012
  glm/glm-5.3:
    inputScale: 1M
    inputPer1kTokens: 0.0014 # $1.40 / 1,000,000
    outputScale: 1M
    outputPer1kTokens: 0.0044 # $4.40 / 1,000,000
```

Rates are stored historically — changing a price does not rewrite past data. Spans already
recorded keep the rate that was active when they ran.

---

## Full Example

```yaml
port: 3000
logLevel: info
wikiRoot: ./config/kb
mcpConfigDir: ./config
artifactRoot: ./config/artifacts

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

embeddings:
  enabled: true
  model: nomic-embed-text
  baseUrl: http://localhost:11434/v1

database:
  path: app.db

observability:
  enabled: true
  spanOutputPreviewChars: 500

afterAgent:
  enabled: true

chat:
  showErrorMessages: false

costs:
  anthropic/claude-sonnet-4-6:
    inputPer1kTokens: 0.003
    outputPer1kTokens: 0.015
  openai/gpt-4.1-mini:
    inputPer1kTokens: 0.0004
    outputPer1kTokens: 0.0012
```

This mirrors `api/config.yaml.example` — the source of truth if this page and the schema ever
drift apart.
