---
title: Why Is Wiki Search Returning Keyword-Only Results?
---

## Why Is Wiki Search Returning Keyword-Only Results?

If [[Wiki Search]] is using only BM25 keyword matching instead of hybrid or semantic search, one of the following is likely the cause.

### 1. Embeddings Are Disabled in config.yaml

Check `config.yaml` for:

```yaml
embeddings:
  enabled: false   # <-- this is the problem
```

Set `enabled: true`, save the file, and restart the server. No other changes are needed if you already have a provider configured.

### 2. No Embedding Provider Is Configured

`embeddings.enabled` may be true, but no provider details have been added. The `embeddings.type` key must point to a configured provider. For example:

```yaml
embeddings:
  enabled: true
  type: ollama
  model: nomic-embed-text
```

See [[Embeddings Configuration]] for all supported providers and their required fields.

### 3. Ollama Embedding Model Not Pulled

If you are using `type: ollama`, the embedding model must be pulled before it can be used. Run:

```bash
ollama pull nomic-embed-text
```

Replace `nomic-embed-text` with whichever model you configured if you chose a different one. After pulling, retry your search — no restart needed.

### 4. The Index Has Not Been Built Yet

The embedding index is built on demand, on the first search after embeddings are enabled. For a large wiki this initial build may take several seconds. Subsequent searches will be fast because only changed pages are re-embedded.

If the first search still returns keyword-only results after waiting, check the server logs for embedding errors.

### 5. The Embedding Model Was Changed

Changing the `embeddings.model` value in `config.yaml` invalidates the existing index. A full rebuild runs automatically on the next search. This is expected behavior — wait for the rebuild to complete, then search again.

### Confirming Which Mode Is Active

Ask the agent:

> "What search mode is the wiki using?"

The agent will report whether hybrid, semantic, or keyword-only search is active and explain why based on your current configuration.

### Related Pages

- [[Wiki Search]]
- [[Wiki Embeddings]]
- [[How to Enable Semantic Search]]
- [[Embeddings Configuration]]
