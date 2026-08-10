---
title: Wiki Domains
---

## Wiki Domains

A wiki domain is a self-contained topic area with its own directory of pages, tag schema, and activity log. Domains let you keep different areas of knowledge cleanly separated so the agent routes queries to the right place.

### The Default Domain

Out of the box, amazing-hashbrown creates a `user` domain for personal context: your preferences, biographical details, and recurring topics that come up in conversation. This domain is always present and cannot be deleted.

### Creating Additional Domains

You can create additional domains for any topic area you want the agent to track separately — for example:

- `homelab` — your servers, network gear, and configurations
- `recipes` — cooking notes and ingredient substitutions
- `work` — projects, colleagues, and processes
- `research` — notes from papers and articles

To create a new domain, see [[How to Create a New Wiki Domain]].

### What Each Domain Contains

Every domain directory has the same structure:

```
domain-name/
  SCHEMA.md       # Tag taxonomy and page conventions
  index.md        # List of all pages in the domain
  log.md          # Recent activity log
  entities/       # Pages of type: entity
  concepts/       # Pages of type: concept
  comparisons/    # Pages of type: comparison
  queries/        # Pages of type: query
  raw/            # Immutable source files
```

See [[Wiki SCHEMA.md]], [[Wiki Page Types]], and [[Wiki Raw Source Files]] for details on each part.

### How the Agent Picks a Domain

When the agent needs to write or search the wiki, it calls `wiki_locate` to find the right domain. This tool scores each domain by matching the content's keywords and tags against each domain's routing notes in `registry.json`. The domain with the best match wins.

If the agent wrote to the wrong domain, see [[Why Did the Agent Write to the Wrong Wiki Domain?]].

### Browsing Domains in the UI

All registered domains appear in the domain filter on the wiki graph and document views at `/wiki`. You can switch between domains, view their pages, and trigger ingestion from the browser.

### Related Pages

- [[How to Create a New Wiki Domain]]
- [[Wiki SCHEMA.md]]
- [[Wiki Page Types]]
- [[Why Did the Agent Write to the Wrong Wiki Domain?]]
