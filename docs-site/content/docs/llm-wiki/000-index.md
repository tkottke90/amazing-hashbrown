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

Having use the LLM Wiki myself, I found it's ability to not only collect and organize information, but also the compounding effect of the wiki to be a powerful and sustainable tool at scale. We added a _routing element_ (a.k.a. multiple sibling wikis) to the LLM Wiki pattern and realized that it could be a powerful core component of an AI Harness.

As such, LLM Wikis became the core memory and knowledge base component of Amazing Hashbrown. The LLM Wiki pattern is used to build the knowledge base for each workspace, and the routing element allows for multiple wikis to be used in parallel, each with their own knowledge base.

![Wiki graph view]({{ '/images/wiki-graph-view.png' | url }})