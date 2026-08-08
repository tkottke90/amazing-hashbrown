---
title: Wiki Page Types
---

## Wiki Page Types

Every wiki page has a `type` field in its frontmatter. The type determines which subdirectory the page lives in, and it guides the agent when searching and reading the wiki. There are five types.

### entity

A specific, nameable person, place, system, or thing. Use this type when the subject can be clearly pointed to and described on its own.

Examples: "Home Router", "DNS Server", "NAS Box", "Alice (colleague)"

Entities live in the `entities/` subdirectory of the domain.

### concept

An idea, process, methodology, or abstract topic that does not map to a single concrete thing.

Examples: "Network Segmentation", "Backup Strategy", "Three-Two-One Rule", "Container Networking"

Concepts live in the `concepts/` subdirectory.

### comparison

A side-by-side contrast of two or more things. Use this type when the main value of the page is in the differences between options.

Examples: "Proxmox vs. ESXi", "Tailscale vs. WireGuard", "ext4 vs. ZFS"

Comparisons live in the `comparisons/` subdirectory.

### query

A captured question-and-answer pair. The agent creates query pages when a conversation produces a useful answer that is worth preserving for future reference.

Examples: "Why does my DNS fail at night?", "What VLAN should smart home devices go on?"

Queries live in the `queries/` subdirectory.

### summary

A high-level overview of a domain section or topic cluster. Summary pages synthesize information from multiple other pages and serve as entry points for broad topics.

Examples: "Homelab Network Overview", "Backup System Summary"

Summaries live in the `entities/` subdirectory alongside entities, as they are typically about a specific system or area.

### How the Agent Chooses a Type

When the agent creates a new page, it picks the type that best fits the content. You can also ask it to use a specific type: "Create a concept page about backup strategies." If a page's type turns out to be wrong, ask the agent to move it: "Change the DNS Server page from concept to entity."

### Frontmatter Fields

Beyond `type`, every page also carries:

- `tags` — one or more tags from the domain's [[Wiki SCHEMA.md]] taxonomy
- `confidence` — `high`, `medium`, or `low`, reflecting how certain the agent is of the content
- `sources` — references to [[Wiki Raw Source Files]] or conversation turns that produced this page

### Related Pages

- [[Wiki Domains]]
- [[Wiki SCHEMA.md]]
- [[Wiki Raw Source Files]]
