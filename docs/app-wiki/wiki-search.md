---
title: Wiki Search
---

## Wiki Search

The `wiki_search` tool searches across all registered wiki domains and returns ranked results. The agent calls it automatically when starting a conversation that might benefit from prior knowledge, and you can trigger it explicitly by asking "search the wiki for X."

### Search Modes

Three modes are supported. The agent selects the best available mode based on your configuration.

#### Hybrid (default when embeddings are configured)

Combines BM25 keyword scoring with embedding vector similarity, fused via Reciprocal Rank Fusion (RRF). Hybrid search gives the best overall accuracy: it finds exact-term matches and conceptually related pages, then merges and re-ranks the two result lists into a single ranked output.

Use hybrid search for most queries. It is the default when an embedding provider is configured.

#### Keyword (BM25)

Term-frequency scoring over page text. Works without any embedding provider — no setup required beyond indexing. Good for precise lookups where you know the exact term you're looking for.

If embeddings are not configured, all searches fall back to keyword mode. See [[Why Is Wiki Search Returning Keyword-Only Results?]] if you expected semantic search but got keyword results.

#### Semantic

Cosine similarity between the query embedding and page embeddings. Finds conceptually related pages even when there is no keyword overlap — useful for exploratory queries and when you are not sure how a topic is named in the wiki.

Requires an embedding provider. See [[Wiki Embeddings]] and [[How to Enable Semantic Search]].

### How Results Are Returned

Search results include:

- The page path (domain + subdirectory + filename)
- A relevance score
- A short snippet showing the matched content

The agent typically follows a search with a `wiki_read_page` call to fetch the full content of the top result.

### Embedding Cache

Embeddings are cached and updated incrementally. When pages are added or edited, only the changed pages are re-embedded on the next search — the full index is not rebuilt from scratch every time. This keeps search fast even on large wikis.

If you change your embedding model, the existing index is invalidated and a full rebuild runs on the next search. This is expected behavior.

### Related Pages

- [[Wiki Embeddings]]
- [[How to Enable Semantic Search]]
- [[Why Is Wiki Search Returning Keyword-Only Results?]]
- [[How the Wiki Works]]
