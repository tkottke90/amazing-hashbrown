---
title: AfterAgent and the Knowledge Base
---

## AfterAgent and the Knowledge Base

After each chat turn, the AfterAgent pipeline runs in the background. You will see a "Working in the background…" spinner in the UI while it runs, and a brief indicator when it finishes. Its job is to decide whether your conversation contained novel, wiki-worthy information and, if so, write it to the appropriate wiki domain.

### The Four Pipeline Steps

AfterAgent runs four steps in sequence:

1. **Summarize** — the turn is condensed into a structured summary, stripping conversational filler and focusing on factual content.
2. **Classify** — the summary is evaluated to determine whether it contains new knowledge not already in the wiki. Factual exchanges about things already covered, purely procedural conversations, and small talk are typically skipped.
3. **Extract** — if the turn passes classification, structured page content is extracted: the page type, tags, key facts, and source references.
4. **Commit** — the extracted content is written to the wiki. The agent uses its full wiki toolset here — it may read existing pages, check for duplicates, and update an existing page rather than create a new one.

### What You Will See

At the end of each turn, one of two indicators appears:

- **Added to knowledge base** — at least one page was created or updated.
- **Nothing new to save** — the turn was skipped (no novel information detected, or AfterAgent is disabled).

### What AfterAgent Can Do During Commit

During the commit step, AfterAgent acts as a full wiki agent. It may:

- Search for existing pages that cover the same topic
- Update an existing page rather than create a duplicate
- Add cross-links between the new page and related pages
- Pick the right domain using `wiki_locate`

### Disabling AfterAgent

To disable AfterAgent globally, set `afterAgent.enabled: false` in `config.yaml` and restart the server. You can also pause it temporarily by asking: "Pause AfterAgent for this conversation."

If AfterAgent is running but never saving anything, see [[Why Isn't the Agent Saving Anything to the Wiki?]].

### Related Pages

- [[Why Isn't the Agent Saving Anything to the Wiki?]]
- [[AfterAgent Pipeline]]
- [[AfterAgent Configuration]]
- [[How the Wiki Works]]
