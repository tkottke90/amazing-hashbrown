# Previous Tasks and Task Notes get a token-budget cap, not a manifest, when generating Task Goal and Handoff Notes

Generating a Task Goal (from Previous Tasks) and Handoff Notes (from Task Notes) are both bare, tool-less model calls that bypass the chat agent's context-window middleware entirely, so an unbounded Previous Tasks list or Task Notes history can overflow the model's input before any work begins — confirmed via a production failure where a single run's Previous Tasks list held 210 entries (393KB) for a Task that had itself run only 6 times, because Previous Tasks is workspace-wide, not scoped to the Task's own history.

We cap each field, at the point it's assembled into its respective prompt, to ~25% of the existing `env.chat.contextWindow.maxTokens` budget: walk backward from the most recent entry (Previous Tasks: by Task File creation order; Task Notes: by Run segment, kept or dropped as a whole) until the next entry would exceed the ceiling, then stop and prepend a single flat count marker (e.g. "...and 187 earlier tasks not shown."). The full, uncapped data stays untouched on disk in the Task File — only what's fed into these two prompts is bounded.

We deliberately did _not_ follow ADR-0039's precedent of surfacing a referenceable manifest for omitted entries: ADR-0039's manifest works because the workspace-chat agent has a tool to go fetch what's manifested. Neither `generateTaskGoal` nor `generateHandoffNotes` binds any tool, so a manifest the model can't act on would just be inert noise — a flat count is the honest equivalent here.

## Considered Options

- **Fixed-count/fixed-length heuristic** (e.g. keep the last N entries, truncate each to M characters) — rejected: doesn't track actual token cost, and a single oversized entry can still blow the budget regardless of how many entries are kept.
- **Cap at write time** (store a trimmed Previous Tasks/Task Notes in the Task File itself) — rejected: Previous Tasks is already fully regenerated every Run anyway, and trimming the stored Task Notes would destroy the one field that's meant to be a Task's own durable per-Run history.
- **A new, independently-tunable env var per field** — rejected: no one has asked to tune this independently of the existing context-window budget, and a second config knob for a value nobody needs to vary separately is exactly the kind of generic escape-hatch `AGENTS.md`'s Composition-over-Customization section warns against.
