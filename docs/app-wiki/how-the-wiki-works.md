---
title: How the Wiki Works
---

## How the Wiki Works

The amazing-hashbrown wiki is a persistent, compounding knowledge base. It is fundamentally different from a retrieval-augmented generation (RAG) system, and understanding that difference helps you get the most out of it.

### RAG vs. the Wiki

In a RAG system, source documents are chunked into fragments, embedded, and stored in a vector database. When you ask a question, relevant chunks are retrieved and passed to the model — but the source documents never change. The system never learns.

The amazing-hashbrown wiki works differently. The agent actively reads and writes structured pages that grow more useful over time. When you have a conversation that contains novel information, the [[AfterAgent and the Knowledge Base|AfterAgent pipeline]] extracts it and writes it to the relevant wiki page. Future conversations query that accumulated knowledge. The wiki gets smarter the more you use it.

### How It Is Organized

The wiki is divided into **domains** — separate topic areas, each with its own directory of structured markdown pages. A fresh installation creates a `user` domain for personal context. You can add more domains for any topic you care about. See [[Wiki Domains]] for details.

Within each domain, pages are organized by **type** — entity, concept, comparison, query, or summary — and live in matching subdirectories. See [[Wiki Page Types]] for the full breakdown.

### Page Structure

Every wiki page is a markdown file with a YAML frontmatter block at the top. The frontmatter records:

- `type` — the page type (entity, concept, etc.)
- `tags` — terms from the domain's tag taxonomy
- `confidence` — `high`, `medium`, or `low`
- `sources` — references to raw source files or conversation turns

Pages can link to each other using `[[Page Title]]` wikilink syntax. The agent follows these links when building context.

### Long-Term Memory

The wiki is the agent's long-term memory. Things it learned in past sessions — your preferences, recurring topics, facts about your systems — are available in new sessions without you having to repeat yourself. The agent searches the wiki at the start of relevant conversations using [[Wiki Search]], and writes back to it after conversations that contain new knowledge.

### Related Pages

- [[Wiki Domains]]
- [[Wiki Page Types]]
- [[Wiki Search]]
- [[AfterAgent and the Knowledge Base]]
