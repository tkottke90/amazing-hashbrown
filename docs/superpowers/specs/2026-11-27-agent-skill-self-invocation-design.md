# Agent Skill Self-Invocation — Design

**Date:** 2026-11-27
**Scope:** `api/src/agents` (`use_skill` tool, shared expansion helper, tool catalog/config, agent builders, system prompt), `suites/tool-calling.yaml`, `bin/eval-setup.ts`, `GLOSSARY.md`, one ADR

Terms in this document (Active Skill, Skill-Gated Tools, Skill-Scoped Tools, Artifact Index) are defined in `GLOSSARY.md` § Skill Invocation & Runtime Access.

## Problem

A skill can only be invoked by a leading `/name` in the human message (`skill-expansion.middleware.ts`). An agent can find skills (`search_skills` returns name, slash command and description) but cannot load one. In non-interactive runs (Tasks, Sub-Agent Tasks) nobody types a slash command, so the agent never gets the skill's instructions, never gets its `tools:`-gated MCP tools, and never gets Skill-Scoped Tools (`read_skill_reference`, `run_skill_script`).

Motivating case: a task that must modify a node in an N8N workflow should be able to self-invoke `/n8n-opts` and get the instructions and the N8N MCP tools that skill declares.

## Goal

A `use_skill(name)` tool, available in every thread type (chat, workspace chat, task, sub-agent), that behaves like a slash command: it loads the skill's instructions and makes it the Active Skill.

## Non-goals

- No set of simultaneously active skills. Active Skill stays single-valued (ADR-0019).
- No skill list in the system prompt.
- No new skill-name resolver or ambiguity handling; self-invoke resolves exactly as `/name` does.
- No compaction exemption for skill bodies (see Open follow-ups).

## Design

### 1. Shared expansion helper

Extract the load-and-format logic from `skill-expansion.middleware.ts` into `skill-expansion.ts`: given a skill source, a name and optional args, return the skill body, then the args, then the Artifact Index (`buildArtifactIndex`), or a not-found result. The slash-command middleware and the new tool both call it; the middleware keeps its own slash-specific not-found wording.

### 2. The tool

`use_skill({ name })`, built as `makeUseSkillTool(getSkills)` where `getSkills` is the same per-agent `SkillSource` the slash-command middleware uses (global for plain chat, the workspace's merged `.agents/skills` otherwise). It resolves the source on every call.

- **Found:** returns `Command({ update: { activeSkill: name, messages: [ToolMessage] } })`. The `ToolMessage` carries the expanded body plus Artifact Index. When a different skill was already active, the content is prefixed "Replaced active skill `a` with `b`." Re-invoking the active skill is allowed.
- **Not found:** returns plain text "Skill "name" not found — use the search_skills tool to see what's available". `activeSkill` is untouched.

A tool returning a `Command` that writes `activeSkill` is an existing pattern (`create-workspace.tool.ts`, `write-task-note.tool.ts`).

### 3. Registration

- `tool-catalog.ts`: `use_skill`, `category: 'built-in'`, `alwaysOn: false`, beside `search_skills`. The `toolId` must equal the tool's name or Tool Access strips it from the model's list.
- `tool-config.ts`: `use_skill`, `read_skill_reference` and `run_skill_script` join `LEGACY_SUB_AGENT_TOOL_IDS`. Chat/task defaults already include every non-MCP catalog tool.
- Same toggle as `search_skills` on the Tool Settings page: an admin who turns off discovery does not get self-invoke through a side door.

### 4. Agent wiring (`chat-agent.ts`)

- `buildSkillTools` returns both `search_skills` and `use_skill`. It already receives each builder's own `SkillSource`, so all four builders (chat, workspace chat, task, sub-agent candidate pool) get the tool with the right source.
- Task agent: add `buildSkillScopedTools()`. Its middleware already declares the `activeSkill` state channel and both gating middlewares.
- Sub-agent: add `buildSkillScopedTools()` to the candidate pool, and add `skillGatedToolsMiddleware`, `skillScopedToolsMiddleware` and `createSkillGatedMcpToolsMiddleware(mcpTools)` to `buildSubAgentMiddleware`, in chat's order. A middleware declaring `activeSkillStateSchema` is required: without one, the tool's `activeSkill` write targets an undeclared channel.
- Comments claiming tasks and sub-agents can never have an Active Skill are rewritten.
- `buildCreateSkillTools` stays chat-only.
- A skill-gated MCP tool still respects an admin's explicit disable (ADR-0074), including in sub-agents.

### 5. Discovery

Two routes, no prompt-wide listing: the agent finds a skill with `search_skills` then loads it with `use_skill`; or a task author names the skill in the task description and the agent calls `use_skill` directly. `SEARCH_SKILLS_SECTION` in `system-prompt.ts` is widened to describe both (gate: `requiresAnyOf: ['search_skills', 'use_skill']`), reusing the existing tag so section counts and ordering are unchanged.

### 6. Evaluation (EDD)

New `tool-call` scenarios in `suites/tool-calling.yaml`, written before the implementation: a prompt that names a skill expects `use_skill` with a `name` argument; a topic prompt that names no skill still expects `search_skills`. `use_skill` is added to `bin/eval-setup.ts`'s `evalTools`. The user runs the suite; no result is reported without a seen run.

## Tests

Developer tests, adjacent to source: the expansion helper (found, not found, args, index); the tool (not found leaves state alone, found returns the `Command` with `activeSkill` and body, replacement note, per-call source resolution); an orchestration test with a real `createAgent()` and a scripted model proving the Active Skill persists and a skill's gated tool binds on the next call; builder assertions in `chat-agent.test.ts` for task and sub-agent tool lists and sub-agent middleware; updates to `tool-config.test.ts` and `system-prompt.test.ts`.

## Open follow-ups

- **Compaction:** a skill body is a `ToolMessage`, so history compaction or the context-window trimmer can condense it on a long run, unlike the slash path (which rewrites a human message). We accept this: the agent can call `use_skill` again. If runs show lost instructions, exempt `name === 'use_skill'` in `selectCompactionCandidates` and the truncation path.
- **Discovery by weak models:** if evals show agents don't reach for `use_skill` unprompted, revisit a compact skill listing in the task prompt.
- **Multiple active skills** would need ADR-0019 and ADR-0023 reworked; out of scope.
