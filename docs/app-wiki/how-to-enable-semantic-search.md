# How to Enable Semantic Search

By default, wiki search uses keyword (BM25) matching only. Enabling semantic search adds an embedding-based ranking layer that finds conceptually related pages even when they don't share exact keywords with your query.

## Step 1 — Choose an embedding provider

Pick the backend that fits your setup:

- **Ollama** — fully local, free, no API key needed. Best for privacy-sensitive or offline setups.
- **OpenAI** — cloud-based, easy if you already have an OpenAI key.
- **Anthropic (Voyage AI)** — cloud-based, high retrieval quality, separate Voyage AI key required.

## Step 2 — Pull the model (Ollama only)

If you're using Ollama, download the embedding model before configuring it:

```sh
ollama pull nomic-embed-text
```

Cloud providers (OpenAI, Anthropic) don't require this step.

## Step 3 — Edit config.yaml

### Ollama (local)

```yaml
embeddings:
  enabled: true
  type: ollama
  baseUrl: http://localhost:11434/v1
  model: nomic-embed-text
```

### OpenAI

```yaml
embeddings:
  enabled: true
  type: openai
  apiKey: sk-...
  model: text-embedding-3-small
```

### Anthropic (Voyage AI)

```yaml
embeddings:
  enabled: true
  type: anthropic
  apiKey: pa-...
  model: voyage-3
```

You can also configure embeddings through the Settings UI under **Settings → Embeddings**, which writes `config.yaml` for you.

## Step 4 — Restart the app

If you edited `config.yaml` directly, restart amazing-hashbrown so it picks up the new settings. If you saved through the Settings UI, the configuration reloads in memory automatically.

## Step 5 — Let the index build

The first `wiki_search` call after enabling embeddings will embed every page in the wiki domain and write the results to `_embeddings.json`. For large wikis this may take a few seconds. Subsequent searches use the cached index and are fast.

## Verifying it's working

Run a search that uses conceptual language rather than exact page titles. If you see results you wouldn't expect from keyword matching alone, hybrid search is active.

## Related pages

See [[Wiki Embeddings]] for a conceptual overview, [[Embeddings Configuration]] for all available config keys, and the individual provider pages — [[Ollama Embedding Provider]], [[OpenAI Embedding Provider]], [[Anthropic Embedding Provider]] — for provider-specific details.
