---
title: Wiki SCHEMA.md
---

## Wiki SCHEMA.md

Every wiki domain has a `SCHEMA.md` file at its root. It defines the tag taxonomy and page conventions for that domain, and the agent reads it every time it orients itself to the domain. Think of SCHEMA.md as standing instructions — it tells the agent how to classify, tag, and structure content for this specific topic area.

### What SCHEMA.md Contains

A well-written SCHEMA.md includes:

- **Domain name and purpose** — a short description of what belongs in this domain and what does not. This also informs routing: the more specific the description, the better `wiki_locate` can distinguish this domain from others.
- **Valid tags** — the complete list of tags the agent may apply to pages in this domain. Tags should be specific enough to be useful for filtering, but not so granular that every page gets unique tags.
- **Page type guidance** — advice on which [[Wiki Page Types|page types]] to prefer for different kinds of content in this domain.
- **Domain-specific conventions** — any naming rules, structural preferences, or things to always or never include on pages in this domain.

### Example SCHEMA.md Structure

```markdown
# homelab

This domain covers home server infrastructure, networking, storage, and related software.
It does not cover general programming topics or recipes.

## Tags

- networking
- storage
- compute
- docker
- backup
- monitoring
- security
- dns
- vlan

## Page Type Guidance

- Use `entity` for specific machines, services, and devices.
- Use `concept` for architectural patterns and strategies.
- Use `comparison` when evaluating two or more options.
```

### Customizing Your Schema

When a new domain is created, a default SCHEMA.md is scaffolded from a template. You should customize it to fit your domain's actual topics. Adding a tag to SCHEMA.md is enough to make it valid — no restart is needed. The agent picks up changes on its next invocation.

### How SCHEMA.md Affects Lint

The `tag_audit` check in [[Wiki Lint]] uses SCHEMA.md as the source of truth for valid tags. If a page carries a tag that does not appear in SCHEMA.md, lint flags it as a warning. This helps catch typos and drift between what you intended and what the agent wrote.

### Related Pages

- [[Wiki Domains]]
- [[Wiki Page Types]]
- [[Wiki Lint]]
- [[How to Create a New Wiki Domain]]
