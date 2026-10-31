---
status: superseded by ADR-0053
---

# Sub-Agent Roles get their own Settings nav entry, not a card on Agent Behavior

Issue #375 asked for a "Sub-Agents card" on the existing Agent Behavior settings page. We deviated: every other add/edit/delete collection in Settings (Tools, Model Settings, MCP Servers) already gets its own dedicated `settings-nav.tsx` entry and panel, precisely because a list with its own CRUD lifecycle doesn't fit alongside a page of unrelated scalar toggles/number inputs — which is all Agent Behavior is today. Sub-Agent Roles are the same shape as those three, so they follow the same precedent: a new "Sub-Agents" nav entry and panel, not a card bolted onto Agent Behavior.
