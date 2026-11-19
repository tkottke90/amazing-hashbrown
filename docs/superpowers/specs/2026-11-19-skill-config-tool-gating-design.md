# Skill-Config-Based Tool Gating — Design

**Date:** 2026-11-19
**Status:** Draft
**Related:** [Issue #409](https://github.com/tkottke90/amazing-hashbrown/issues/409) (related: #408, #415)

---

## Goal

Move Skill-Gated Tools (GLOSSARY.md § Skill Invocation & Runtime Access) off a hardcoded registration array and onto each skill's own `SKILL.md` frontmatter, reconciled live against the real tool catalog — including MCP tools — and wire the Settings UI's shelved "Allowed tools" field up as the editing surface for it.

## Problem

See issue #409 for the full write-up: `GATED_SKILL_REGISTRATIONS` requires a code change to add or edit a binding, and the Settings UI's `skill-details-tab.tsx` has a commented-out field and TODO waiting on exactly this. Not repeated here.

**Correction found during the architecture pass:** the natural-looking fix — moving `skill-gated-tools.middleware.ts` to run after `toolAccessMiddleware` so it can add back a skill-gated MCP tool the same way `createMcpToolDiscoveryMiddleware` does — breaks `tool-access.middleware.ts`'s own `boundIds` computation (used for `#tool-name`'s required-tool-block injection and `filterHarnessSections`), which explicitly depends on an *inactive* skill-gated tool already being stripped out of `request.tools` by the time it runs. Built-in gating stays exactly where it is; MCP gating is added as a second, separate middleware positioned where `createMcpToolDiscoveryMiddleware` already is. See Architecture §4.

---

## Decisions (settled via grilling)

| Question | Decision |
| --- | --- |
| Replace or coexist with `GATED_SKILL_REGISTRATIONS` | Replace entirely. `gated-skill-registrations.ts` is deleted; every app-level skill (including the 4 existing registrations) declares its own gated tools in its own `SKILL.md` frontmatter. |
| Which skills can gate tools | App-level/system skills only for this issue. Workspace-authored skills are out of scope — a follow-up, with its own trust-model design, since gating bypasses Tool Access. |
| MCP tools in scope | Yes. A skill's tools can include MCP tools, not just built-ins. |
| Bind shape for a skill-gated MCP tool | Direct bind — bound automatically whenever its skill is Active, same as a built-in skill-gated tool. No `search_mcp_tools`/`use_mcp_tools` round-trip. |
| Admin disable vs. skill-gating, for MCP tools | Admin disable wins (ADR-0071) — asymmetric with a built-in skill-gated tool's full exemption from Tool Access. |
| Unknown tool name in a skill's declaration | Silently dropped at reconciliation time, not a skill-boot failure. The Settings UI flags it as unknown. |
| Frontmatter field shape | Comma-separated string — same shape the existing (unrelated) `allowed-tools` field already has. |
| Frontmatter field name | `tools`. Deliberately not `allowed-tools` (reserved, ecosystem-standard *restrictive* meaning) or `gated-tools`. User-facing label: "Tools this skill has access to." |
| Freshness | Recomputed live from `SkillsManager` on every model call — an edit takes effect on the next turn, no restart. |
| MCP id format inside `tools` | The existing display-id convention (`server:tool`, e.g. `n8n:workflow_search`) — no new id scheme. |
| Delete protection | Dynamic: any skill whose own `tools` field is non-empty is undeletable. `GATED_SKILL_NAMES` is removed, no replacement hardcoded list. |
| Agent-settable via chat | Not in this issue. `create_app_skill`/`edit_app_skill` keep their current parameters; `tools` is UI-only for now. |
| Settings UI picker grouping | Grouped by source: Built-in, then each connected MCP server. |
| Disabled tool visibility in the picker | Shown, grayed out ("disabled — won't take effect") — not hidden. |
| AlwaysOn tools in the picker | Included as selectable, even though gating one is a no-op. |

---

## Architecture

### 1. Frontmatter and manager-level types

`lib/skills-manager/src/types.ts`: add `tools?: string` to `SkillFrontmatter`, `CreateSkillInput`, and `EditSkillInput`, parallel to the existing `allowedTools`/`allowed-tools` field. `internal/frontmatter.ts`'s `validateFrontmatter`/`serialize` pass it through verbatim — no catalog-aware validation at this layer, same treatment `allowed-tools` already gets ("parsed and stored as-is").

Add `tools?: string` to `SkillSummary` too, populated at `boot()`/`create()`/`edit()` time (same place `largeDesc` is derived from `frontmatter.description`) — this is what lets `list()`/`search()` answer "does this skill gate anything, and what" straight from the in-memory cache, with no extra per-skill disk read. `SkillsManager.create()`/`.edit()` thread `tools` into the frontmatter object alongside `allowedTools`, same pattern.

`ui/src/services/skills-manage-api.ts` mirrors the same new field on its own `SkillFrontmatter`/`CreateSkillInput`/`EditSkillInput` interfaces.

### 2. Pure reconciliation helper — `api/src/agents/skill-tool-gating.ts`

A new, dependency-light module (mirrors the `tool-syntax.ts`/`mcp-tool-discovery.ts` pure-helper split):

```ts
export function resolveSkillGatedRegistrations(
  skills: Pick<SkillSummary, 'name' | 'tools'>[],
): SkillGatedToolRegistration[]
```

Parses each skill's raw `tools` string (split on comma, trim, drop empties) and returns one registration per skill with a non-empty list — the exact same `SkillGatedToolRegistration[]` shape `createSkillGatedToolsMiddleware` already takes today, so that factory's signature for the built-in half doesn't change shape, only how its input is produced. Deliberately does **not** touch `TOOL_CATALOG`, the live MCP catalog, or `tool-config.ts` — "is this name real" and "is this MCP tool disabled" are resolved downstream, at the point of use, not here. This is what keeps `bin/eval.ts`'s import light (per `gated-skill-registrations.ts`'s own existing header comment on why it was split out of `chat-agent.ts` in the first place): the eval harness calls `resolveSkillGatedRegistrations(evalSkillsManager.list())` once at setup and passes the result into the unchanged middleware factory, exactly as it passes `GATED_SKILL_REGISTRATIONS` today.

A skill's raw `tools` entries split into two shapes by one existing convention, reused rather than reinvented: an MCP display id always contains a colon (`server:tool`); a built-in tool name never does (confirmed against every `TOOL_CATALOG` entry). Both the built-in-filtering middleware and the new MCP-addition middleware (§4) partition on `name.includes(':')`, the same test `tool-access.middleware.ts` already uses to tell the two id spaces apart.

### 3. Built-in half — `skill-gated-tools.middleware.ts` (unchanged position, unchanged shape)

Stays exactly where it runs today (before `toolAccessMiddleware`) and keeps its pure-filter behavior for built-in tool names unchanged. Only its input source changes: the factory takes a live accessor instead of a frozen array —

```ts
export function createSkillGatedToolsMiddleware(
  getSkills: () => Pick<SkillsManager, 'list'> = () => skillsManager,
)
```

— and calls `resolveSkillGatedRegistrations(getSkills().list())` fresh inside `wrapModelCall`, filtered to the colon-free (built-in) half of each registration's `toolNames`. `list()` reads `SkillsManager`'s in-memory cache, so this is cheap on every call, and an edit made through the Settings UI (which calls `SkillsManager.edit()`, updating that cache synchronously) is visible on the very next model call with no agent-cache bust needed.

`chat-agent.ts`'s module-scope `const skillGatedToolsMiddleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS)` becomes `createSkillGatedToolsMiddleware()` (default accessor, same pattern `toolAccessMiddleware`'s own default-exported singleton already uses).

### 4. MCP half — new `createSkillGatedMcpToolsMiddleware` (new middleware, positioned like `createMcpToolDiscoveryMiddleware`)

A second, separate middleware, not a change to §3's existing one, because of the ordering constraint identified in the Problem section's correction. Same factory shape as `createMcpToolDiscoveryMiddleware`:

```ts
export function createSkillGatedMcpToolsMiddleware(
  getSkills: () => Pick<SkillsManager, 'list'>,
  mcpTools: ClientTool[],
)
```

On each `wrapModelCall`: resolve the active skill's registration (same `resolveSkillGatedRegistrations` call, filtered to the colon-containing/MCP half this time); convert each display id forward to its `boundName` via `toBoundMatchKeys()` (never the reverse, same rule every other MCP-aware middleware in this codebase already follows); check each against `getGloballyEnabledToolIds()`/`resolveEffectiveToolIds(threadId)` (`request.runtime.configurable?.thread_id`, same read `toolAccessMiddleware` does) and drop any that resolve to disabled — this is where ADR-0071 is actually enforced; look up the survivors in `mcpTools` by `boundName` and add any not already in `request.tools`, same addition shape `createMcpToolDiscoveryMiddleware` already uses.

Placed immediately after `toolAccessMiddleware`, alongside `createMcpToolDiscoveryMiddleware` (order between the two doesn't matter — both only add tools, never remove). Wired into `buildChatAgent`, `buildWorkspaceChatAgent`, and `buildTaskAgent`'s middleware arrays; **not** added to `buildSubAgentMiddleware`, which doesn't carry `skillGatedToolsMiddleware` or `skillScopedToolsMiddleware` today either — sub-agents don't support skill-gating at all, unchanged by this design.

### 5. `tool-catalog.ts` / `tool-access.ts`

The 12 existing built-in skill-gated `CatalogEntry` rows keep `category: 'skill-gated'`/`alwaysOn: false` (still accurate — these are real catalog tools of that nature) but drop the hardcoded `skillCommand?: string` field: it assumed one tool maps to exactly one skill, which is no longer guaranteed once gating is frontmatter-driven (two skills could independently declare the same tool). Anything that showed "which skill backs this tool" (the Tool Settings page's informational row) derives it at render time instead, by scanning the already-fetched skill list's `tools` fields client-side — not a new backend concept.

`SKILL_GATED_TOOL_IDS` in `tool-access.ts` is unaffected — it's still just "every catalog entry tagged `category: 'skill-gated'`," which doesn't depend on `skillCommand` at all.

### 6. Delete protection and workspace-skill reservation become dynamic

- `api/src/routes/v1/skills.route.ts`: the module-scope `const GATED_NAMES = GATED_SKILL_REGISTRATIONS.map(...)` becomes a per-request computation inside the `DELETE` handler: `skillsManager.list().filter((s) => s.tools).map((s) => s.name)`. Cheap (in-memory), and correct the instant a skill's `tools` field is cleared or set.
- `api/src/services/workspace-skills.ts`: `reserved: GATED_SKILL_REGISTRATIONS.map((r) => r.skillCommand)` becomes the same dynamic derivation against the global manager's own `list()`, keeping today's protection (a workspace skill can't shadow a gated app skill's name) without a hardcoded array.
- `ui/src/pages/settings/skill-gated-names.ts` is deleted. `skill-details-tab.tsx`'s `isGated` becomes `Boolean(skill.frontmatter.tools)`.

### 7. Migrating the 4 existing registrations

`api/src/services/default-skills.ts`'s seeded `CreateSkillInput` objects for `create-workspace`, `create-project`, `resolve-file-conflict`, and `create-skill` each gain a `tools` value carrying over their current registration 1:1 (e.g. `create-workspace` → `tools: 'create_workspace'`; `create-skill` → the same 9-tool comma list `GATED_SKILL_REGISTRATIONS` has today). `gated-skill-registrations.ts` and its test coverage are deleted outright once this lands.

`bin/eval.ts`, `bin/eval-setup.ts`, `bin/eval-stream-trace.ts` swap their `GATED_SKILL_REGISTRATIONS` import for `resolveSkillGatedRegistrations(evalSkillsManager.list())`, called once at setup — no other change to those files' shape.

### 8. Settings UI — `skill-details-tab.tsx`

The commented-out `allowedTools` input is replaced with a real multi-select over the reconciled catalog, reusing the existing resolved tool-settings data (`listResolvedToolSettings()`, already exposed via the Tool Settings page's endpoint — no new backend endpoint needed) rather than inventing a parallel catalog view. That data already carries `category`, `mcpServer`, `alwaysOn`, and `enabled` per entry, which is exactly what's needed for:

- grouping options by Built-in vs. each MCP server (§Decisions),
- rendering a disabled entry grayed out rather than hiding it,
- including `alwaysOn` entries as selectable (deliberately, even though gating one is a no-op — the person's call, not this design's).

On load, the skill's own `frontmatter.tools` (comma string) is parsed into selected ids; any selected id absent from the fetched catalog renders as an "Unknown tool" chip in the editor (distinct from reconciliation's silent server-side drop at gating time — the editor still shows the author what's actually written in frontmatter, including a stale entry, so they can see and remove it). Saving serializes the current selection back to a comma string through the existing `saveSkillDetails` → `PATCH /api/v1/skills/:name` → `SkillsManager.edit()` path, now carrying `tools`.

---

## Testing

Per root `AGENTS.md` and `api/AGENTS.md`:

- **Unit**: `resolveSkillGatedRegistrations` (comma parsing, empty/whitespace handling, colon-based built-in/MCP partition).
- **Orchestration**: `skill-gated-tools.middleware.test.ts` updated for the live-accessor signature (same filter assertions as today, now against a stubbed `getSkills`). New `skill-gated-mcp-tools.middleware.test.ts` mirroring `mcp-tool-discovery.middleware.test.ts`'s pattern — real `toolAccessMiddleware` chained with the new one, asserting: a skill-gated MCP tool is bound while its skill is Active, absent otherwise, and absent even while Active if the admin has disabled it (ADR-0071's actual enforcement point).
- **External-orchestration / handler tests**: `skills.handlers.test.ts`'s `deleteSkillHandler` tests updated for the dynamic `gatedNames` computation; `workspace-skills.test.ts` updated for the dynamic `reserved` list.
- **UI**: `skill-details-tab` tests for the new multi-select (selection round-trips to frontmatter `tools`, an unknown id renders as flagged, a disabled MCP tool renders grayed out).

## Evaluation (EDD, per root `AGENTS.md`)

A skill-gated MCP tool binding directly, with no `search_mcp_tools`/`use_mcp_tools` step, is a new path alongside the one #415 just taught the model to rely on by default. There's a real risk the model still attempts a redundant search/use detour out of habit even when the tool is already bound. Per EDD rule 1, a failing eval scenario should be written before implementation covering: given an Active skill whose declared MCP tool is already bound, the model calls it directly on the first attempt, not via a discovery detour. Exact scenario/suite placement is an implementation-time decision, same carve-out the MCP Tool Discovery design took for its own scenarios.

---

## Out of scope

- Workspace-authored skills declaring their own gated tools (deferred — needs its own trust-model design, since gating bypasses Tool Access entirely).
- Exposing `tools` on `create_app_skill`/`edit_app_skill` as an agent-settable parameter.
- Any change to `MCP Tool Discovery`'s own Turn-scoped grant mechanism (`search_mcp_tools`/`use_mcp_tools`) — the two paths coexist, as noted in GLOSSARY.md's `Discovered Tool` entry.

---

## See also

- GLOSSARY.md § Skill Invocation & Runtime Access (**Skill-Gated Tools**, **Skill Tools Field**) and § MCP Tool Discovery (**Discovered Tool**).
- ADR-0071 (skill-gated MCP tools still respect an admin's explicit disable).
- `docs/superpowers/specs/2026-11-11-mcp-tool-discovery-design.md` (the design this one's MCP half builds directly on top of, and whose "Out of scope" section named this issue as the follow-up).
