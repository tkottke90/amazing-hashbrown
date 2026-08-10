---
title: Wiki Lint
---

## Wiki Lint

The `wiki_lint` tool runs a suite of health checks on a wiki domain and reports findings grouped by severity: **error**, **warn**, and **info**. Run it regularly to keep your wiki well-connected and accurate.

### How to Run It

Ask the agent: "Run wiki lint on the homelab domain." The agent calls `wiki_lint`, formats the results, and can attempt to fix findings in the same session. For step-by-step instructions, see [[How to Run Wiki Lint and Fix Findings]].

### The 12 Checks

#### Link and Structure Checks

- **broken_links** — wikilinks pointing to pages that do not exist. The agent can remove or redirect these.
- **orphans** — pages with no inbound links from any other page. These are at risk of becoming forgotten. The agent adds cross-links from related pages.
- **index** — pages on disk that are not listed in `index.md`. The agent updates the index automatically.
- **quality** — pages with too few outbound wikilinks, which may indicate isolated or under-connected content.

#### Frontmatter and Schema Checks

- **frontmatter** — pages missing required fields (`type`, `tags`, `confidence`, or `sources`).
- **tag_audit** — tags used on pages that do not appear in the domain's [[Wiki SCHEMA.md]] taxonomy. Either add the tag to SCHEMA.md or correct it on the page.
- **contradictions** — pages that contradict each other according to their frontmatter metadata.

#### Content and Freshness Checks

- **page_size** — pages that are unusually short (possibly stub pages) or very long (possibly should be split).
- **stale** — pages that have not been updated in a long time. Review these to check whether the information is still accurate.
- **source_drift** — raw source files whose content has changed since the wiki page was generated (detected via SHA256 mismatch). See [[Wiki Raw Source Files]].

#### System Checks

- **log_rotation** — the activity log (`log.md`) is growing too large and should be trimmed.
- **registry_sync** — wiki domain directories on disk that are not registered in `registry.json`.

### Severity Levels

| Severity | Meaning                                               |
| -------- | ----------------------------------------------------- |
| error    | Something is broken and will cause incorrect behavior |
| warn     | Something is degraded or potentially incorrect        |
| info     | A suggestion for improvement                          |

### Related Pages

- [[How to Run Wiki Lint and Fix Findings]]
- [[Wiki SCHEMA.md]]
- [[Wiki Raw Source Files]]
- [[Wiki Domains]]
