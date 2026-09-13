# Tool Settings Redesign — Table, Drawer, and Config-Driven Storage — Design

**Date:** 2026-09-13
**Status:** Draft
**Related:** [Issue #171](https://github.com/tkottke90/amazing-hashbrown/issues/171) (original feature), [Issue #63](https://github.com/tkottke90/amazing-hashbrown/issues/63) (webFetch/rlm config location), [Issue #154](https://github.com/tkottke90/amazing-hashbrown/issues/154) (per-tool system prompt sections)
**Supersedes:** the Settings UI, storage layer, and sub-agent scoping from `2026-09-12-tool-management-ui-design.md` (shipped in PR #180). The per-thread `thread_tools`/`tools_customized_at` mechanism and the "Edit Tools" chat drawer from that design are **unchanged** and out of scope here.

---

## Goal

Fix real usability problems found in manual testing of the shipped tool-management feature (PR #180), and close two related, long-standing issues along the way:

1. **Grouping by category is confusing** — finding a tool means knowing its type first. Replace with a single alphabetical table.
2. **Tool configuration is split across two places** — e.g. Web Fetch has both a row in the Tool Access list and its own separate settings card. Consolidate into one per-tool drawer.
3. **Descriptions can be very long** (some MCP servers, e.g. Context7, ship 5+ line descriptions) — truncate in the table, show in full in the drawer.

Along the way:

- Close **issue #63**: `webFetch`/`rlm` config move out of config.yaml's top level.
- Close **issue #154**: let a tool optionally carry an instruction block that gets injected into the system prompt when that tool is actually active for the turn.
- Fix a real architectural inconsistency: every other Settings section is backed by `config.yaml` via `configManager` (`api/src/config/env.ts`, `api/src/routes/v1/settings.handlers.ts`); the shipped `ToolSettingsStore` is the only settings-shaped state living in SQLite instead. Move it to match.
- Give the Sub-Agent context (`buildSubAgentAgent`) genuine, config-driven tool control instead of a hardcoded allowlist — while keeping the two tools that are structurally incompatible with a sub-agent run (not just "risky") hard-excluded in code.

---

## Problem

### UI

`ToolAccessSection` (`ui/src/pages/settings/tool-access-section.tsx`) renders four separate grouped `<ul>`s (Built-in, Wiki, Skill-gated, MCP-by-server). Finding a specific tool requires already knowing which group it's in. MCP tool descriptions render unclamped, so a verbose server can push a single row to 5+ lines and break the visual rhythm of the page. Meanwhile `ToolsPanel` (`ui/src/pages/settings/tools-panel.tsx`) renders three more cards — Web Fetch, Retrieval Loop Model, Shell Execution — for tool-specific config that has no relationship to the Tool Access rows above it, even though two of those three tools (`web_fetch`, `rlm_query`) already have their own row in that same list.

### Storage

`ToolSettingsStore` (`api/src/services/tool-settings-store.ts`, SQLite migration v28) owns `enabled`/`default_include` for every catalog tool. Every other piece of user-editable app configuration — providers, embeddings, agent behavior, cost rates, and yes, `webFetch`/`rlm`/`shell` themselves — lives in `config.yaml` via `configManager`, with a uniform get/patch/reload pattern (`api/src/routes/v1/settings.handlers.ts`'s `SLUG_MAP`). `tool_settings` is the one exception, for no reason tied to its actual requirements — it doesn't need SQLite's transactional/relational features the way `thread_tools` (a real per-thread join table) does.

### Sub-Agent tooling

`buildSubAgentAgent()` (`api/src/agents/chat-agent.ts`) binds a fixed, hand-maintained `SUB_AGENT_TOOLS` array — not the shared `STATIC_CHAT_TOOLS`, not filtered by `tool-access.middleware.ts` at all. There is no way to give a sub-agent run access to a specific MCP tool, or to `shell_exec`, without a code change. Two of the tools this hardcoded list excludes (`ask_user`, `spawn_sub_agent`) are excluded for structural reasons — not policy — and that distinction needs to survive into whatever replaces the hardcoded list.

---

## Scope

**In scope:**

- New alphabetical table + per-tool drawer, replacing `ToolAccessSection`'s grouped lists and `ToolsPanel`'s three config cards.
- Move all per-tool state — `enabled`, per-context `defaultInclude`, `description` override, `instructions`, and the existing `webFetch`/`rlm_query`/`shell_exec` tool-specific config — into `config.yaml` under a flat `tools.<toolId>` map. Closes issue #63 as part of the same migration.
- Shrink SQLite `tool_settings` to a pure MCP-discovery cache (identity + connection status only). `thread_tools`/`threads.tools_customized_at` are untouched.
- New optional per-tool `instructions` field, dynamically injected into the system prompt at call time when the tool is active for that turn. Closes issue #154.
- Replace `buildSubAgentAgent`'s hardcoded `SUB_AGENT_TOOLS` allowlist with the same config-driven `defaultInclude.subAgent` mechanism used for Chat, with `ask_user` and `spawn_sub_agent` hard-excluded in code.
- Add a `defaultInclude.autonomous` field to the data model and drawer for forward compatibility; `buildTaskAgent` does **not** change its enforcement behavior in this project (see §6).

**Out of scope:**

- Anything about the per-thread `thread_tools` table, `tools_customized_at`, the per-thread REST routes, or the chat window's "Edit Tools" drawer — all shipped and unchanged.
- Actually wiring `defaultInclude.autonomous` into `buildTaskAgent`'s enforcement.
- Building an actual "Custom" tool type (user-defined tools). The Source column's derivation is written to make room for a future `custom` category, but no such category is produced anywhere yet.
- MCP per-server isolation, skill-gated tool runtime semantics — both already correct from PR #180 and untouched here.

---

## Design

### 1. Settings > Tools — table

Replaces `ToolAccessSection`'s four grouped lists with one table, sorted alphabetically by name, columns **Name | Description | Source**:

- A keyword search box above the table filters by name/description substring — needed once a single MCP server can add dozens of tools (Context7, Playwright, etc.) and a flat alphabetical list is the only browse mechanism left.
- Description is CSS line-clamped to 2 lines with an ellipsis; the drawer shows it in full.
- Source is derived from category: `built-in` / `wiki` / `skill-gated` → **Built-in**; `mcp` → **MCP**. (The derivation function is a switch keyed on category, written so a future `custom` category is a one-line addition — no work item to actually produce one.)
- Hovering a row highlights it (`:hover` background). Clicking anywhere on the row opens the drawer for that tool.

This table becomes the *only* content of the "Tool Access" section — `ToolsPanel`'s three separate config cards for Web Fetch / RLM / Shell are deleted; their fields move into the relevant tool's drawer (§2).

### 2. The drawer

Opens on row click. Header: tool name, Source badge, and (MCP only, read-only) the owning MCP server name.

Body, generic fields for every tool:

- **Description** — editable textarea, prefilled with the effective description (override if set, else the catalog/discovered default).
- **Instructions** — editable textarea, empty by default. See §5.
- **Include by default** — three switches: **Chat**, **Sub-Agent**, **Autonomous** (Autonomous renders but has no runtime effect yet — labelled "coming soon"). All three are disabled/greyed when the tool's own Enabled switch is off.
- **Enabled** — switch.

Footer: **Reset Defaults** / **Save**.

- **Save** validates the form and issues one `PATCH /api/v1/tool-settings/:toolId` with every changed field (generic + tool-specific).
- **Reset Defaults** issues `DELETE /api/v1/tool-settings/:toolId` immediately (no separate Save needed) — clears this tool's entire config.yaml entry, so every field reverts to its computed default. Mirrors the existing per-thread drawer's Save/Reset split (`PUT`/`DELETE`), and the `DELETE`-means-"clear override" precedent from `threads.route.ts`.

Category-specific drawer behavior:

- **`alwaysOn` catalog tools** (per `TOOL_CATALOG` — today, every `wiki` tool plus `complete_task`): Enabled and all three "include by default" switches are locked on with an "Always on" note, regardless of category. Description/Instructions remain editable.
- **Skill-gated** tools: fully read-only, same as today (skill status note, no switches) — the row still opens a drawer, just a non-editable one.
- **Built-in / MCP** tools: full generic fields as above.

Tool-specific extra fields, rendered in the drawer only for these three toolIds, directly below the generic fields, all part of the same form/Save:

| toolId | Extra fields |
|---|---|
| `web_fetch` | Timeout (ms), Respect robots.txt |
| `rlm_query` | Provider, Model, Max iterations, Truncate threshold |
| `shell_exec` | Allowlist, Denylist (matches today's `ToolsPanel` fields exactly — working directory is derived per-agent-context at runtime, not user-configured, and isn't shown today either) |

### 3. Data model

**config.yaml** — new flat `tools.<toolId>` map. Existing `tools.shell` is renamed `tools.shell_exec`; top-level `webFetch`/`rlm` move to `tools.web_fetch`/`tools.rlm_query` (closing issue #63 as part of the same rename, since both are one-time acceptable breaking changes to `config.yaml` per that issue's own migration note). An entry is only written when at least one field diverges from its computed default:

```yaml
tools:
  shell_exec:
    enabled: true
    defaultInclude: { chat: true, subAgent: false, autonomous: true }
    allowlist: ['**/*.txt']
    denylist: []
  web_fetch:
    enabled: true
    defaultInclude: { chat: true, subAgent: true, autonomous: true }
    timeoutMs: 10000
    respectRobotsTxt: true
  rlm_query:
    defaultInclude: { chat: true, subAgent: false, autonomous: true }
    maxIterations: 10
    truncateThreshold: 6000
  browser_click:                     # example MCP tool — toolId is the bare tool name, same key ToolSettingsStore already uses
    enabled: false
    description: "Custom override text"
```

Schema: `ToolsConfigSchema = z.record(toolIdPattern, ToolEntrySchema)`, where `ToolEntrySchema` covers the generic optional fields (`enabled`, `defaultInclude: { chat, subAgent, autonomous }`, `description`, `instructions`) plus a catchall for unknown extra properties. The three known special-cased toolIds get their extra fields validated against their existing typed schemas (`WebFetchConfigSchema`, `RLMConfigSchema`, `ShellExecutorConfigSchema`) at the handler level, mirroring how `settings.handlers.ts`'s `tools` slug already merges partial typed sections today.

Reads merge stored config.yaml entries over computed defaults:

- `enabled` defaults to `true`.
- `defaultInclude.chat` defaults to `true` for every catalog tool (matches today's seeded behavior — everything opt-out, not opt-in).
- `defaultInclude.subAgent` defaults to `true` only for the toolIds in today's `SUB_AGENT_TOOLS` list (`wiki_search`, `wiki_read_page`, `wiki_locate`, `wiki_orient`, `wiki_lint`, `web_fetch`, `get_tool_key`, `rlm_query`, `search_skills`, `search_conversation`), `false` otherwise — this is what makes the migration behavior-preserving for existing installs.
- `defaultInclude.autonomous` defaults to `true` for every tool currently bound in `buildTaskAgent` (i.e. same as today's unconditional set).
- `enabled` and every `defaultInclude` field are forced `true` and non-patchable for `alwaysOn` catalog tools (wiki tools, `complete_task`), regardless of what's stored in config.yaml — same rule the drawer enforces (§2).
- `description`/`instructions` default to the catalog entry's description / empty string respectively; for `mcp` tools, `description` defaults to whatever was captured at discovery time.

**SQLite `tool_settings`** shrinks to a pure MCP-discovery cache — drop `enabled`/`default_include` (new migration), keep `tool_id`, `name`, `description` (as-discovered, immutable — the config.yaml override is a separate concept layered on top at read time), `mcp_server`, `last_seen_at`, `last_status`, `updated_at`. `thread_tools` and `threads.tools_customized_at` are untouched — they're genuine per-thread relational state, not configuration.

### 4. API

`GET /api/v1/tool-settings` — for every catalog tool (built-in/wiki/skill-gated, static) and every row in the SQLite discovery cache (mcp), merge in its config.yaml entry per the default rules above, and return the full list the table needs. Same endpoint also feeds the drawer (no separate per-tool GET — the list is already fully loaded).

`PATCH /api/v1/tool-settings/:toolId` — body carries any subset of the generic fields plus (for the three known toolIds) their extra fields; merges into `tools.<toolId>` in config.yaml via the same `mergeConfigYaml`/`configManager.reload()` pattern as every other settings slug. 400 for: unknown toolId; any field at all on a `skill-gated` tool (fully read-only, matching its drawer — see §2); or `enabled`/`defaultInclude` on an `alwaysOn` catalog tool — wiki tools and `complete_task` (their drawer still allows editing `description`/`instructions`, since those aren't locked always-on the way availability is).

`DELETE /api/v1/tool-settings/:toolId` — removes `tools.<toolId>` from config.yaml entirely (Reset Defaults).

`POST /api/v1/tool-settings/refresh` — unchanged from PR #180 (live MCP discovery, writes through to the SQLite cache only).

Every write triggers the same reload/invalidate sequence `patchSettingsSectionHandler` already runs for other slugs (`configManager.reload()`, `invalidateChatAgent()`), since a tool's `enabled`/`defaultInclude` affects the next agent build via the dynamic middleware read (§5), not the cached agent construction itself.

### 5. System-prompt instruction injection (issue #154)

`tool-access.middleware.ts`'s `wrapModelCall` already reads the thread's effective tool set fresh on every call (never baked in at agent-build time, to avoid the cross-thread cache leak `getChatAgent`/`getWorkspaceChatAgent` would otherwise cause). Extend it: after computing the filtered tool list for this call, collect the non-empty `instructions` field of every tool that survived the filter, wrap each in its own tag —

```
<tool_guidance:web_fetch>
...instructions text...
</tool_guidance>
```

— and append the joined block to `request.systemMessage`, following the same per-section tagging convention `system-prompt.ts`'s `wrapSection()` already uses for the static `HARNESS_SECTIONS`. A tool with no `instructions` set contributes nothing. This is purely additive to the existing system prompt — no change to `buildSystemPrompt()` itself, since the injection point is call-time middleware, not build-time prompt assembly.

### 6. Sub-Agent enforcement

`buildSubAgentAgent()` drops the hardcoded `SUB_AGENT_TOOLS` constant. Its tool list becomes: every catalog/MCP tool whose effective `defaultInclude.subAgent` is `true` (via the same config-driven resolution used for Chat), **except** `ask_user` and `spawn_sub_agent`, which are filtered out in code unconditionally — never offered as toggleable in the drawer's Sub-Agent column at all. Reasoning (already validated with the user): `ask_user`'s `interrupt()` has nothing watching to resume it in a sub-agent run (hangs, doesn't just weaken safety); `spawn_sub_agent` has no nesting-depth guard today, so allowing it would let a sub-agent spawn another sub-agent unbounded. The migration's `defaultInclude.subAgent` defaults (§3) reproduce today's exact `SUB_AGENT_TOOLS` membership, so no existing sub-agent run's tool set changes until someone edits it via the new drawer.

`buildSubAgentAgent()` now goes through `tool-access.middleware.ts` the same way Chat/Autonomous already do (previously it had no tool-access middleware at all, relying entirely on its hand-maintained tool array for scoping).

`buildTaskAgent` (**Autonomous**) is unchanged in this project — it keeps using the same dynamic thread-based effective-tool-set resolution it already uses today. `defaultInclude.autonomous` exists in the data model and drawer (so the UI/schema doesn't need another migration when this is wired up later) but nothing reads it yet.

---

## Migration notes

- `config.yaml`: `webFetch`/`rlm` (top-level) and `tools.shell` are renamed to `tools.web_fetch`/`tools.rlm_query`/`tools.shell_exec`. One-time breaking change to hand-edited config files, consistent with issue #63's own accepted migration note — call it out in the PR description.
- SQLite: new migration drops `tool_settings.enabled`/`default_include` columns. No data migration needed for `defaultInclude` values — the config.yaml default rules (§3) reproduce current behavior for every existing install without requiring a backfill.
- Any config.yaml file with no `tools.*` entries at all behaves identically to today (all computed defaults apply) — this is a purely additive schema change for anyone who hasn't customized anything yet.

---

## Testing

- Unit: config.yaml read/merge logic for `tools.<toolId>` (defaults + overrides, including the three special-cased tools' extra fields validating against their existing typed schemas); the middleware's instruction-injection (a tool with `instructions` set appears in the system prompt only when it survives the filter, tag format correct, empty instructions contribute nothing); `buildSubAgentAgent`'s new config-driven binding (an MCP tool flagged `defaultInclude.subAgent: true` is bound; `ask_user`/`spawn_sub_agent` are never bound regardless of config).
- Frontend: table rendering/search/sort: drawer open-on-click, generic field save/reset, the three tool-specific extra-field sections rendering only for their matching toolId, wiki/skill-gated read-only variants.
- Manual: toggle a tool off globally, confirm it's absent from the next chat turn's bound tools; set an MCP tool's Sub-Agent include on, dispatch a sub-agent, confirm it's bound; confirm `ask_user`/`spawn_sub_agent` never appear as Sub-Agent-toggleable in the drawer regardless of what's in config.yaml.
- `npm run eval` is not required — no system-prompt *default* content changes (only a new dynamic, opt-in per-tool injection point with no seeded instructions by default).
