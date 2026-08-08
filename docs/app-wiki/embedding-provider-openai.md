# OpenAI Embedding Provider

The OpenAI embedding provider uses OpenAI's embedding API to generate vectors for semantic wiki search. It's a good choice when you're already using OpenAI as your chat provider and want consistent cloud-based infrastructure.

## Configuration

Embeddings are configured in the `embeddings` section of `config.yaml`:

```yaml
embeddings:
  type: openai
  apiKey: sk-...
  model: text-embedding-3-small
```

### Fields

- `type` — set to `openai`.
- `apiKey` — your OpenAI API key (the same key you use for the [[OpenAI Provider]]). You can reuse the same key; no separate credential is needed.
- `model` — the embedding model to use. Options:
  - `text-embedding-3-small` — fast and cost-effective; suitable for most wikis. This is the default.
  - `text-embedding-3-large` — higher-quality vectors at greater cost; recommended for large wikis where search precision matters.

No `baseUrl` is needed; the standard OpenAI API endpoint is used automatically.

## Costs and caching

OpenAI embedding calls are billed per token at OpenAI's standard embedding rates. To keep costs low:

- Vectors are cached in `_embeddings.json` per wiki domain directory.
- Only pages whose content has changed since the last search are re-embedded — the rest are served from cache.
- After the initial full index build, ongoing costs are minimal unless you are frequently editing many pages.

Changing the `model` field invalidates the cache and triggers a full rebuild on the next search.

## Related pages

See [[Wiki Embeddings]] for how embeddings integrate with wiki search, [[How to Enable Semantic Search]] for setup instructions, and [[Anthropic Embedding Provider]] for an alternative cloud embedding option.
