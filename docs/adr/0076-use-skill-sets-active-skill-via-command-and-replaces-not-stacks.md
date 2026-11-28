# `use_skill` sets Active Skill via a tool `Command` and replaces, not stacks

Agents could find skills (`search_skills`) but only a human typing `/name` could load one, which left tasks and sub-agents — where nobody types — unable to get a skill's instructions, its `tools:`-gated MCP tools or its Skill-Scoped Tools.

`use_skill(name)` returns a `Command` that writes `activeSkill` and a `ToolMessage` carrying the skill body plus Artifact Index (shared with the slash-command path through `expandSkill`). Returning body-only text was rejected: it would load instructions but unlock nothing, and the motivating case (a skill that declares N8N MCP tools) needs the unlock.

Active Skill stays single-valued (ADR-0019, ADR-0023): invoking a second skill replaces the first, and the tool result says so, so the model knows the earlier skill's tools are gone. A set of active skills would mean reworking how `read_skill_reference`/`run_skill_script` resolve "which skill" via `toolCall.args`, and nothing requires it yet.

It is bound in every thread type, so sub-agents gain the `activeSkill` state channel and the skill-gating middlewares they previously omitted; admin-disabled MCP tools still win over a skill's gate (ADR-0074).

Known cost: the body lives in a `ToolMessage`, so history compaction or context trimming can condense it on a long run, unlike a slash command's transient human-message rewrite. Accepted — the agent can call `use_skill` again. Exempt `use_skill` results from compaction if runs show lost instructions.
