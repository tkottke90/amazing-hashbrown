---
title: Embeddings
section: Configuration
order: 5
layout: doc.njk
---

{% from "macros/code.njk" import code %}

## Embeddings

Powers semantic and hybrid ranking for the `wiki_search` tool, and the semantic-search step inside `rlm_query`. When disabled, or when the embeddings endpoint is unreachable, both fall back to keyword-only matching — degraded, not broken.

| Key       | Type    | Default                       | Description                                           |
| --------- | ------- | ------------------------------ | ------------------------------------------------------ |
| `enabled` | boolean | `true`                          | Whether an embedding provider is constructed at all.   |
| `type`    | string  | `"ollama"`                      | `ollama` or `openai`.                                   |
| `model`   | string  | `"nomic-embed-text"`            | Embedding model name.                                   |
| `baseUrl` | string  | `"http://localhost:11434/v1"`   | Base URL of the embeddings endpoint.                    |
| `apiKey`  | string  | —                                | Required when `type` is `openai`.                       |

{% call code(language="yaml") %}
embeddings:
  enabled: true
  type: ollama
  model: nomic-embed-text
  baseUrl: http://localhost:11434/v1
{% endcall %}

For OpenAI-hosted embeddings instead of a local Ollama model:

{% call code(language="yaml") %}
embeddings:
  enabled: true
  type: openai
  model: text-embedding-3-small
  apiKey: ${OPENAI_API_KEY}
{% endcall %}
