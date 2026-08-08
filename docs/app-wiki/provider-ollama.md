# Ollama Provider

Ollama is the local-first LLM backend for amazing-hashbrown. It runs entirely on your own hardware — no API key, no cloud account, and no usage costs. This makes it a great choice for privacy-sensitive workloads or air-gapped environments.

## Configuration

Set `type: ollama` in your provider entry inside `config.yaml`.

```yaml
providers:
  - name: my-ollama
    type: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3.1
```

### Required fields

- `name` — an arbitrary label shown in the UI to identify this provider.
- `baseUrl` — the base URL where Ollama is listening. The default Ollama port is `11434`.
- `defaultModel` — the model that will be pre-selected when you open a new conversation with this provider (e.g. `llama3.1`, `qwen2.5:7b`, `mistral`).

### Optional fields

- `apiKey` — a bearer token passed in the `Authorization` header. Most self-hosted Ollama instances do not require this, but it may be needed if you've placed Ollama behind an authenticating reverse proxy.

## Pulling models

Models must be downloaded before they can be used. Run:

```sh
ollama pull llama3.1
ollama pull nomic-embed-text   # if you also want local embeddings
```

Any model you have pulled will appear automatically in the model switcher — amazing-hashbrown queries Ollama's `/api/tags` endpoint at runtime to build the list.

## Docker users

If Ollama is running on the host machine and amazing-hashbrown is inside a container, use the Docker-specific hostname instead of `localhost`:

```yaml
baseUrl: http://host.docker.internal:11434
```

## Related pages

See [[How to Set Up Ollama]] for a full installation walkthrough, and [[Ollama Embedding Provider]] if you want to use a local Ollama model for semantic wiki search.
