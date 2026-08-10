# Anthropic Embedding Provider (Voyage AI)

The Anthropic embedding provider uses Voyage AI — Anthropic's recommended embedding service — to generate high-quality vectors for semantic wiki search. Voyage AI models are optimized for retrieval tasks and tend to perform well on technical and knowledge-base content.

## Configuration

Embeddings are configured in the `embeddings` section of `config.yaml`:

```yaml
embeddings:
  type: anthropic
  apiKey: pa-...
  model: voyage-3
```

### Fields

- `type` — set to `anthropic`. Despite the name, this embedding provider calls the Voyage AI API, not the Anthropic chat API.
- `apiKey` — your **Voyage AI** API key. This is a separate credential from your Anthropic chat API key (`sk-ant-...`). Obtain it from the [Voyage AI dashboard](https://dash.voyageai.com).
- `model` — the Voyage model to use. `voyage-3` is the default and a strong general-purpose choice. Check Voyage AI's documentation for the current model lineup and pricing.

## Costs and caching

Voyage AI charges per token for embedding requests. Costs are kept low by the same caching strategy used by all embedding providers:

- Vectors are stored in `_embeddings.json` inside each wiki domain directory.
- Only pages whose content has changed since the last search are re-embedded; unchanged pages are served from the local cache.
- Changing the `model` field invalidates the cache and triggers a full index rebuild on the next search.

## Related pages

See [[Wiki Embeddings]] for how embedding vectors are used in search, [[How to Enable Semantic Search]] for step-by-step setup, and [[OpenAI Embedding Provider]] for an alternative cloud option.
