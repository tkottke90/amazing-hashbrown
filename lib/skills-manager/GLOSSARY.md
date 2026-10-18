# Skills

Slash-command-invoked units of instructions, and the mechanisms that gate tools behind them or let the agent invoke them on its own initiative instead.

## Language

**Skill**:
A named, slash-command-invoked unit of instructions (a Markdown body plus frontmatter) that expands into the conversation once its exact `/command` appears as the human's own message. Built-in Skills are app-wide; a workspace may also define its own under `.agents/skills`, shadowing a same-named built-in.
_Avoid_: command, macro, prompt template

**Gated Skill**:
A Skill registered in `GATED_SKILL_REGISTRATIONS` — while it is active, a fixed set of otherwise-hidden tools becomes visible to the model. Being gated is independent of being an Agent-Invocable Skill; a Gated Skill may also be Agent-Invocable, but only its Agent-Exposable tools actually become visible when it's invoked that way.
_Avoid_: privileged skill, tool-gating skill

**Agent-Invocable Skill**:
A Skill whose frontmatter marks it eligible to be invoked by the agent itself, mid-conversation, via `invoke_skill` — without the human having typed its `/command`. Distinct from an ordinary Skill, which only ever expands off a literal human-typed slash command.
_Avoid_: self-invoked skill, auto skill

**`invoke_skill`**:
The tool that looks up an Agent-Invocable Skill (reusing `search_skills`'s matching) and returns its body as a tool result — the same lookup-then-return-content shape as `wiki_read_page`. If the matched Skill is also a Gated Skill, invoking it this way opens its tool gate only for that Skill's Agent-Exposable tools; any gated tool without that flag stays hidden regardless.
_Avoid_: skill lookup tool, auto-invoke

**Agent-Exposable**:
A per-tool setting, alongside `defaultInclude: { chat, subAgent, autonomous }`, marking a tool safe to surface when its Gated Skill is opened via `invoke_skill` rather than a human-typed slash command. Off by default. A different axis from `autonomous` (which governs unattended/headless task-runner access) — a tool can be `autonomous: true` and not Agent-Exposable, or the reverse.
_Avoid_: autonomous (reserved for the existing, differently-scoped setting), self-gated
