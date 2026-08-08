# Ollama Embedding Provider

The Ollama embedding provider generates embedding vectors locally using a model you run on your own machine. It requires no API key and incurs no usage costs, making it the recommended choice for fully local setups.

## Configuration

Embeddings are configured in the `embeddings` section of `config.yaml`:

```yaml
embeddings:
  type: ollama
  baseUrl: http://localhost:11434/v1
  model: nomic-embed-text
```

### Fields

- `type` — set to `ollama`.
- `baseUrl` — the Ollama OpenAI-compatible endpoint. Note the `/v1` suffix; this differs from the chat API base URL used by the [[Ollama Provider]].
- `model` — the embedding model to use. `nomic-embed-text` is the recommended default. Other options include `mxbai-embed-large` or any embedding model available in the Ollama library.

## Pulling the embedding model

The model must be downloaded before it can be used:

```sh
ollama pull nomic-embed-text
```

Embedding models are separate from chat models — pulling a chat model like `llama3.1` does not install `nomic-embed-text`.

## How embeddings are stored

Vectors are computed incrementally and persisted to `_embeddings.json` inside each wiki domain directory. Only pages whose content has changed since the last search are re-embedded, so after the initial index build, most searches trigger zero new embedding requests.

If you change the `model` field, the existing index is considered stale and will be rebuilt from scratch on the next search.

## Docker users

If Ollama is on the host machine and amazing-hashbrown is in a container, use:

```yaml
baseUrl: http://host.docker.internal:11434/v1
```

## Related pages

See [[Wiki Embeddings]] for how embeddings integrate with wiki search, and [[How to Enable Semantic Search]] for step-by-step setup instructions.
