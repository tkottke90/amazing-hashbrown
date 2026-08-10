# Wiki Embeddings

Embedding vectors power the semantic half of wiki search. Understanding how they work helps you configure them effectively and troubleshoot search quality.

## What embeddings do

When you search the wiki, amazing-hashbrown converts both your query and each wiki page into high-dimensional numeric vectors using an embedding model. Pages whose vectors are geometrically closest to the query vector are ranked as more relevant — even if they share no words in common.

This is what allows `wiki_search` to surface conceptually related pages. A query like "how do I configure DNS?" can match a page titled "Network routing setup" because the underlying concepts are similar, even though the words differ. Combined with keyword (BM25) scoring in a hybrid ranking pass, the result is a search that handles both exact terminology and fuzzy intent.

## Storage and incremental updates

Embedding vectors are stored in a file called `_embeddings.json` inside each wiki domain directory. This file is managed automatically — you do not need to create or edit it directly.

Embeddings are computed **incrementally**:

- On the first search after enabling embeddings, every page in the domain is embedded and written to `_embeddings.json`.
- On subsequent searches, only pages whose content has changed since the last embedding pass are re-processed. Unchanged pages are served from the cached vectors.

This keeps API costs and latency low for day-to-day use. A full rebuild is only triggered when you change the embedding `model` in your config, at which point the existing index is discarded and all pages are re-embedded.

## Fallback

If no embedding provider is configured, or if `enabled` is set to `false` in the `embeddings` config block, `wiki_search` falls back to keyword-only BM25 mode automatically. Search continues to work — it just loses the semantic relevance layer.

## Supported providers

Three embedding backends are available:

- [[Ollama Embedding Provider]] — local, free, no API key required.
- [[OpenAI Embedding Provider]] — cloud-based, pay-per-use, easy to set up if you already use OpenAI.
- [[Anthropic Embedding Provider]] — Voyage AI, cloud-based, high retrieval quality.

## Related pages

See [[Embeddings Configuration]] for all config keys, and [[How to Enable Semantic Search]] for a setup walkthrough. For the full picture of how search works, see [[Wiki Search]].
