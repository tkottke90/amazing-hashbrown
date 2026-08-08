---
title: How to Create a New Wiki Domain
---

## How to Create a New Wiki Domain

A wiki domain is a self-contained topic area with its own pages, tag schema, and activity log. You can create as many domains as you need, and the agent will route knowledge to the right one automatically.

### Option 1 — Ask the Agent

The simplest way is to tell the agent directly:

> "Create a new wiki domain for homelab."

The agent calls `wiki_create_domain`, which:

1. Scaffolds the full directory structure (`entities/`, `concepts/`, `comparisons/`, `queries/`, `raw/`)
2. Creates a starter `SCHEMA.md`, `index.md`, and `log.md`
3. Registers the domain in `registry.json`
4. Starts an onboarding conversation to help you define the domain's tags and conventions

Walk through the onboarding prompts to give the domain a focused description and a useful starting tag set. The more specific you make it, the better `wiki_locate` can route queries to it.

### Option 2 — Use the Wiki View

If you prefer a browser-based flow:

1. Open the Wiki view at `/wiki` in the app.
2. Open the ingestion chat panel on the right side of the page.
3. Describe the domain you want to create: "I want a new domain for tracking recipes."
4. The wiki-focused agent will guide you through setup interactively.

### After Creation

Once the domain is created:

- It appears in the domain filter on the wiki graph and document views.
- `wiki_locate` will start routing relevant queries to it.
- The AfterAgent pipeline (see [[AfterAgent and the Knowledge Base]]) can write to it automatically.

### Customizing the Domain

Edit the generated [[Wiki SCHEMA.md]] to add domain-specific tags and conventions. You can do this in the browser's wiki view or by asking the agent: "Update the homelab domain schema to add a `proxmox` tag."

Changes to SCHEMA.md take effect immediately — no restart needed.

### Related Pages

- [[Wiki Domains]]
- [[Wiki SCHEMA.md]]
- [[AfterAgent and the Knowledge Base]]
- [[Why Did the Agent Write to the Wrong Wiki Domain?]]
