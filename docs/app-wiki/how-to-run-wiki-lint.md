---
title: How to Run Wiki Lint and Fix Findings
---

## How to Run Wiki Lint and Fix Findings

Wiki lint checks the health of a domain's pages, links, and metadata. Running it regularly keeps your wiki well-connected and accurate. For a full description of all 12 checks, see [[Wiki Lint]].

### Running Lint

Ask the agent:

> "Run wiki lint on the homelab domain."

The agent calls `wiki_lint`, prints findings grouped by severity (error, warn, info), and can attempt fixes in the same session.

You can also run lint on all domains at once:

> "Run wiki lint on all domains."

### Common Findings and How to Fix Them

#### broken_links

Wikilinks that point to pages that do not exist. The agent will either remove the dead link or redirect it to the correct page.

Ask: "Fix the broken links in the homelab domain."

#### orphans

Pages with no inbound links from any other page. The agent finds related pages and adds cross-links to connect the orphan back into the wiki graph.

Ask: "Fix the orphan pages in the homelab domain."

#### tag_audit

Pages carrying tags that are not in the domain's [[Wiki SCHEMA.md]] taxonomy. To fix: either add the tag to SCHEMA.md (if it is a valid new tag) or ask the agent to correct the tag on the page.

Ask: "Add the tag `proxmox` to the homelab SCHEMA.md."

#### source_drift

A raw source file's content has changed since the wiki page was generated (SHA256 mismatch). Ask the agent to rebaseline:

> "Rebaseline the drifted source files in the homelab domain."

See [[Wiki Raw Source Files]] for more on drift detection.

#### stale

Pages that have not been updated in a long time. Review them to check whether the information is still accurate. The agent can mark them as reviewed or regenerate them if you provide updated information.

#### index

Pages on disk that are not listed in `index.md`. The agent updates `index.md` automatically when this finding appears.

### Fixing Specific Findings

You can ask the agent to address a single finding rather than all of them:

> "Fix only the orphan findings in the homelab domain."
> "Update the index for the user domain."

### Related Pages

- [[Wiki Lint]]
- [[Wiki SCHEMA.md]]
- [[Wiki Raw Source Files]]
- [[Wiki Domains]]
