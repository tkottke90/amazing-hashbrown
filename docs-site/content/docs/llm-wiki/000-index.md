---
title: Overview
section: LLM Wiki
order: 1
layout: doc.njk
permalink: /docs/llm-wiki/
---

## LLM Wiki

LLM Wiki was a concept created by _Andrej karpathy_ ([Original Gist](https://gist.github.com/karpathy/8a9f3c7e2b5d0f1e4c6e1f3e4c6e1f3e)) to provide a pattern for building knowledge bases with LLMs. Breaking from strategies like RAG, LLM Wiki has the LLM organize the information rather than relying exclusively on semantic search (e.g. vector databases). This allows for more flexible and dynamic knowledge bases that can be updated and expanded over time.

### LLM Wiki and Amazing Hashbrown

_Amazing Hashbrown_ uses the LLM Wiki pattern as the core memory component.  It is well known that LLMs struggle with context (especially in long conversations).  LLM Wiki was chosen because it provides the following benefits:

- All content is curated - All information is managed by the Agent and the Agent has instructions to constantly reflect on not only the information but it's impact to the wiki as a whole.
- All data is plain text - No proprietary formats or database that requires special tools to access the raw data.  Everything is stored in JSON or Markdown format.



