# Embeddings Configuration

The `embeddings` section of `config.yaml` controls which backend generates vectors for semantic wiki search. All keys are optional — if the section is absent entirely, wiki search runs in keyword-only (BM25) mode.

## Full example

```yaml
embeddings:
  enabled: true
  type: ollama
  baseUrl: http://localhost:11434/v1
  model: nomic-embed-text
  # apiKey: <not needed for Ollama>
```

## Keys

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch. Set to `false` to disable semantic search globally and fall back to BM25, regardless of other settings. |
| `type` | — | Embedding backend: `ollama`, `openai`, or `anthropic`. Required if `enabled` is `true`. |
| `model` | provider default | Embedding model name. Each provider has its own default (e.g. `nomic-embed-text` for Ollama, `text-embedding-3-small` for OpenAI, `voyage-3` for Anthropic). |
| `baseUrl` | — | Required for `ollama`; omit for `openai` and `anthropic`. Include the `/v1` suffix for Ollama. |
| `apiKey` | — | Required for `openai` and `anthropic`; omit for `ollama`. |

## Fallback behaviour

When embeddings are disabled (or no provider is configured), `wiki_search` automatically falls back to keyword-only BM25 search. There is no error — search still works, it just loses the semantic relevance layer.

## Switching models

If you change the `model` field, the existing embedding index is considered invalid. The next `wiki_search` call will rebuild the index from scratch by re-embedding every page in the wiki domain. For large wikis this may take a moment and incur additional API costs.

## Related pages

See [[Ollama Embedding Provider]], [[OpenAI Embedding Provider]], and [[Anthropic Embedding Provider]] for provider-specific setup guides. See [[Wiki Embeddings]] for a conceptual overview of how embedding vectors are used in search.
