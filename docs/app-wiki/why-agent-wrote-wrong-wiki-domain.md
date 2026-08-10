---
title: Why Did the Agent Write to the Wrong Wiki Domain?
---

## Why Did the Agent Write to the Wrong Wiki Domain?

The agent routes wiki writes to a domain using `wiki_locate`, which scores all registered domains by matching the content's keywords and tags against each domain's routing notes in `registry.json`. If it picked the wrong domain, there are a few common causes.

### Cause 1 — Overlapping Domain Descriptions

Two domains have similar tags or keywords in their routing notes, so `wiki_locate` cannot reliably distinguish between them.

**Fix:** Edit each domain's [[Wiki SCHEMA.md]] to make the topic boundaries more specific and distinct. Then update the routing notes in `registry.json` by asking the agent:

> "Update the routing notes for the homelab domain to clarify that it covers self-hosted infrastructure, not general programming."

The more specific and non-overlapping the routing notes, the better `wiki_locate` performs.

### Cause 2 — The Right Domain Did Not Exist Yet

The target domain had not been created, so the agent fell back to the closest matching domain.

**Fix:** Create the correct domain and move the misplaced page:

> "Create a new wiki domain for networking."
> "Move the page entities/dns-server.md from homelab to networking."

See [[How to Create a New Wiki Domain]] for the full domain creation flow.

### Cause 3 — Ambiguous Topic

The content genuinely spans multiple domains, and either choice was reasonable. The agent made a judgment call.

**Fix:** Decide which domain is the better home, then ask the agent to move the page:

> "Move the page concepts/vlan-strategy.md from user to homelab."

You can also ask the agent to create cross-links so the page is discoverable from the other domain even though it lives in one.

### Preventing Future Misroutes

- Keep each domain's SCHEMA.md focused and distinct. Avoid repeating the same tags across multiple domains.
- Use specific, non-generic language in domain descriptions (e.g. "self-hosted Proxmox infrastructure" rather than "servers").
- After editing routing notes, test by asking: "Which domain would you write a page about DNS to?" and see what the agent answers.

### Related Pages

- [[Wiki Domains]]
- [[Wiki SCHEMA.md]]
- [[How to Create a New Wiki Domain]]
- [[AfterAgent and the Knowledge Base]]
