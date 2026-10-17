# Widget Source and Maintainer are set by the calling code, never by request/tool-call input

#315 lets an agent (an LLM, via a conversational tool call) or a CLI-driven automation write a widget's content, and the #176 mockup shows each widget tagged with where its last update came from. If `source` were a field the request body or the agent's own tool-call arguments could set, a prompt-injected or simply buggy caller could claim `manual` for a write it made itself, making the provenance badge untrustworthy. Instead, each of the three entry points — the drawer route, the new content route, and the agent tool — hardcodes its own `source` value in the handler call; nothing external ever supplies it. `maintainer` is the one piece of provenance an Agent/CLI caller _does_ choose, as a self-chosen label (e.g. a script name) — but `source` itself stays a server-side fact, not client input.

## Considered Options

- Give the agent tool's schema a `source` field the model fills in (e.g. "agent" or "automation") — rejected: an LLM-controlled field describing its own authorship is not a trust boundary worth relying on.
