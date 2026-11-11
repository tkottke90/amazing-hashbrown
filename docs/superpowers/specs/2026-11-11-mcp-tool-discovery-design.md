# On-Demand MCP Tool Discovery — Design

**Date:** 2026-11-11
**Status:** Draft
**Related:** [Issue #408](https://github.com/tkottke90/amazing-hashbrown/issues/408) (related: #402, #403, #407, #409)

---

## Goal

Stop binding every connected MCP server's full tool catalog to every Turn by default. Instead, give the model a single, cheap, always-available way to search for an MCP tool by keyword and explicitly pull in only the ones it actually needs — see GLOSSARY.md § MCP Tool Discovery for the settled vocabulary this design builds on (**MCP Tool Discovery**, **Discovered Tool**).

## Problem

See issue #408 for the full write-up (61 tool schemas / 11,900-token system prompt bound on every turn of a thread that enabled one MCP server, regardless of whether that turn needed it — a direct contributor to the local-model latency problems in #402/#403/#407). Not repeated here.

**Correction to the issue's own premise, found during grilling:** the issue assumes a discovered tool gets wired in "the same way `#tool-name`'s `requestedToolIds` already survives filtering to get bound." It doesn't — `docs/superpowers/specs/2026-09-14-explicit-tool-syntax-design.md` explicitly decided `#tool-name` never force-binds a tool outside the already-bound set, and `tool-access.middleware.ts`'s `buildRequiredToolBlocks` only emphasizes tools already present in `request.tools`. This design does not reuse or modify that mechanism (see Decisions table) — it adds new, separate plumbing.

---

## Decisions (settled via grilling)

| Question | Decision |
| --- | --- |
| Scope | MCP tools only. Built-in tool defaults are untouched. |
| How "no catalog bound by default" is implemented | `tool-config.ts`'s `resolveToolSettings()` flips its `defaultInclude.chat` fallback from `true` to `false`, but only for `category: 'mcp'`. Every other category, `alwaysOn`, and every stored override (global Tool Settings, per-thread customization) behaves exactly as before. |
| Disabled tools and discovery | A globally- or thread-disabled MCP tool is invisible to `search_mcp_tools` and cannot be granted by `use_mcp_tools` — same invisibility contract disabled tools already have. |
| Relationship to `#tool-name` | Untouched. A new, separate mechanism carries discovery grants; `#tool-name`'s shipped "never force-bind" contract is not modified. (Consequence: `#some-undiscovered-mcp-tool` typed by a user is still a silent no-op, same as today for any disabled tool — accepted, not a regression in kind.) |
| Discovery flow | Two tools. `search_mcp_tools({ keyword? })` returns matches (display id, name, description — never the internal `boundName`) from the *entire* MCP catalog, regardless of each match's current per-call binding state. `use_mcp_tools({ toolIds: [...] })` is a separate, explicit grant — nothing is bound just because it appeared in a search result. |
| Grant lifetime | Turn-scoped (GLOSSARY.md's existing **Turn** definition). A grant does not survive into the next Turn; the recurring case is explicitly #409's job, not this one's. |
| `use_mcp_tools` feedback | Returns which ids were accepted and, for each rejected id, *why* — `no such tool` vs. `disabled` — distinct outcomes, not lumped together, so the model can self-correct a typo or stop and tell the user why it isn't using something. |
| Tool Settings exemption | Both `search_mcp_tools` and `use_mcp_tools` are `alwaysOn: true` in `TOOL_CATALOG` — they are the only door back into the MCP catalog, so Tool Access can't close it. |
| Sub-agent reachability | Both new tools get `defaultInclude.subAgent: true`. Structurally, MCP-category tools stop being gated by `getSubAgentToolIds()`'s static build-time allowlist at all (built-in tools still are) — they're always in a sub-agent's candidate pool, gated per-call by the same discovery middleware chat/workspace/task use. An explicit `defaultInclude.subAgent: false` override for a specific MCP tool is still a hard opt-out; only the common "no override" case moves from "never reachable" to "reachable via discovery." |
| UI | None. No new chat-UI surface. The existing thread report's tool-chip rendering (`model-input-snapshot.middleware.ts`) already shows what was actually bound per call, for free. |

---

## Architecture

### 1. Default-binding change — `api/src/agents/tool-config.ts`

In `resolveToolSettings()`, the `defaultInclude.chat` line becomes category-aware:

```ts
const defaultInclude: ResolvedDefaultInclude = {
  chat: base.alwaysOn
    ? true
    : (stored?.defaultInclude?.chat ?? (base.category === 'mcp' ? false : true)),
  ...
};
```

Nothing else in `getGlobalDefaultToolIds()` / `resolveEffectiveToolIds()` / `tool-access.middleware.ts` changes — they already read whatever `defaultInclude.chat`/`enabled` resolve to. Because `stored` is a `config.yaml` entry (not a `ToolSettingsStore` row — see `tool-config.ts`'s own header comment), an installation that already has an explicit override for a specific MCP tool keeps that override byte-for-byte; only the *no-override* fallback changes. No migration, no backfill.

Task runs (`buildTaskAgent`) need no separate change: `defaultInclude.autonomous` is computed but never read anywhere in `api/src` today (confirmed by inspection) — task runs resolve their tool set through the same `.chat`-based `resolveEffectiveToolIds()` path interactive chat uses, so this one change covers both.

A thread with an existing customization snapshot (`tools_customized_at IS NOT NULL`, captured before this ships) keeps whatever MCP tools were in its old snapshot — this is the same "old snapshots don't retroactively pick up new global defaults" behavior any other default change in this system already has, not special-cased here.

### 2. Two new tools

`api/src/agents/tools/search-mcp-tools.tool.ts` — modeled directly on `search-skills.tool.ts`:

- Input: `{ keyword?: string }`.
- Reads the live MCP catalog (`toolsManager.list()` filtered to `source: 'mcp'`, cross-referenced against resolved tool settings to exclude disabled ones — same data `tool-config.ts`'s `listResolvedToolSettings()` already assembles).
- Output: for each match, display id (colon form, e.g. `n8n:workflow_search`), name, description. Never `boundName`.
- No pagination, no per-server browsing mode — keyword substring match only, same shape as `search_skills`.

`api/src/agents/tools/use-mcp-tools.tool.ts`:

- Input: `{ toolIds: string[] }` (display ids).
- Validates each id against the same resolved catalog: a real, non-disabled MCP tool → accepted; no such id → rejected (`reason: 'not_found'`); a real but disabled tool → rejected (`reason: 'disabled'`).
- Output: `{ accepted: string[], rejected: { toolId: string, reason: 'not_found' | 'disabled' }[] }`.
- The tool's own execution does not mutate any shared/graph state — see §3 for how a grant actually becomes visible.

Both are `alwaysOn: true`, `category: 'built-in'` entries in `TOOL_CATALOG`.

### 3. Turn-scoped grant tracking — no new graph state needed

`recursion-guard.middleware.ts` already establishes the pattern this reuses: derive everything fresh from `state.messages`/`request.messages` on every call, rather than threading a new stateSchema field through `beforeAgent`/`wrapModelCall`. A new pure helper (`api/src/agents/mcp-tool-discovery.ts`, mirroring the `tool-syntax.ts`/`tool-syntax.middleware.ts` split so the logic stays framework-agnostic):

```ts
// Walks request.messages backward until the Turn boundary (the last human
// message — same boundary Turn is already defined against in GLOSSARY.md),
// collecting the `accepted` list from every use_mcp_tools ToolMessage seen
// along the way. Multiple use_mcp_tools calls within one Turn union
// together — a later call narrowing its own ask doesn't un-grant an
// earlier one.
export function computeDiscoveredToolIds(messages: BaseMessage[]): Set<string>
```

### 4. New middleware — `api/src/agents/mcp-tool-discovery.middleware.ts`

A factory, same shape as `createSkillGatedToolsMiddleware`/`createToolAccessMiddleware`, taking the agent's own MCP tool candidate list (the `mcpTools` array `loadMcpTools()` already produces, which — as today — stays structurally present in every builder's full `tools:` array passed to `createAgent`, purely so `ToolNode` can execute a call if one ever comes through):

```ts
export function createMcpToolDiscoveryMiddleware(mcpTools: ClientTool[]) {
  // Keyed by boundName (mcpTools' own .name) — the same forward-only
  // colon-to-double-underscore conversion tool-config.ts's
  // toBoundMatchKeys() already uses. Parsing a boundName back into a
  // display id is deliberately never relied on anywhere in this codebase
  // (see toBoundMatchKeys()'s own comment), so this converts the discovered
  // display id forward to its boundName form to do the lookup, never the
  // reverse.
  const byBoundName = new Map(mcpTools.map((t) => [t.name, t]));
  return createMiddleware({
    name: 'McpToolDiscoveryMiddleware',
    wrapModelCall: async (request, handler) => {
      const discoveredIds = computeDiscoveredToolIds(request.messages);
      const boundSet = new Set(request.tools.map((t) => t.name));
      const additions = [...toBoundMatchKeys(discoveredIds)]
        .map((boundName) => byBoundName.get(boundName))
        .filter((t): t is ClientTool => t !== undefined && !boundSet.has(t.name));
      if (additions.length === 0) return handler(request);
      return handler({ ...request, tools: [...request.tools, ...additions] });
    },
  });
}
```

**Placement in the middleware array**: immediately after `toolAccessMiddleware` in every builder's array. This ordering is what makes the mechanism work at all — `toolAccessMiddleware` runs first (more outer) and strips non-customized MCP tools out of `request.tools` under the new default; this middleware runs next (more inner) and receives that already-filtered set, adding back only the ones actually Discovered this Turn.

In `buildChatAgent`/`buildWorkspaceChatAgent`/`buildTaskAgent`, that position is also before `createContextWindowMiddleware` (which already runs after `toolAccessMiddleware` in all three today), so the token-budget estimate correctly accounts for whatever got added back.

`buildSubAgentMiddleware`'s existing array order is the odd one out — `createContextWindowMiddleware` already runs **before** `toolAccessMiddleware` there today, not after (unlike the other three builders). This design doesn't reorder it: the new middleware still goes immediately after `toolAccessMiddleware` (i.e. between it and `ambientContextMiddleware`), which means a sub-agent run's context-window budget estimate won't account for a Discovered tool's schema cost — the same pre-existing gap that estimate already has with respect to `toolAccessMiddleware`'s own filtering, not a new one this design introduces. Reordering that is a separate, unrelated fix if it's ever wanted.

### 5. Sub-agent structural change — `api/src/agents/tool-config.ts` / `chat-agent.ts`

`getSubAgentToolIds()` stops considering MCP-category tools at all (it keeps gating every built-in tool exactly as today). `buildSubAgentToolCandidates()` keeps spreading the full `mcpTools` array unconditionally (as it already does), but `buildSubAgentAgent`'s `allowedBoundNames` filter is applied only to non-MCP candidates — MCP tools pass through to the final `tools:` array unconditionally, same as chat/workspace/task, and get the same `createMcpToolDiscoveryMiddleware` added to `buildSubAgentMiddleware()`'s array (after `toolAccessMiddleware`, which the comment on `buildSubAgentAgent` already confirms is a no-op pass-through with no `thread_id` in scope — harmless, since this new middleware's logic needs no `thread_id` either, only `request.messages`).

An MCP tool with an explicit `defaultInclude.subAgent: false` override in `config.yaml` stays hard-excluded — `getSubAgentToolIds()`'s exclusion-by-explicit-override still applies before this new middleware ever sees it, since that case is config-driven and checked separately from the "was it discovered" check.

### 6. System prompt

A new always-on `HARNESS_SECTIONS` entry (`system-prompt.ts`), parallel to the one `#tool-name` added, documenting: MCP tools aren't all bound by default; call `search_mcp_tools` to find one by keyword; call `use_mcp_tools` with the ids actually needed before expecting to call them; a grant lasts only for the rest of this Turn. Exact prose is an implementation-time task, validated via the auto-eval loop — not fixed by this design.

### 7. Testing

Per the root and `api/AGENTS.md` testing rules: unit tests for `computeDiscoveredToolIds` (Turn-boundary scanning, multi-call union), the two new tools (accept/reject/validation branches), the new middleware (orchestration-level — real `toolAccessMiddleware` chained with the new one, asserting a non-customized MCP tool is absent by default and present after a synthetic `use_mcp_tools` ToolMessage), and the `tool-config.ts`/`getSubAgentToolIds()` changes (an MCP tool id is never returned, a built-in id still gates exactly as before, an explicit `subAgent: false` override still excludes).

### 8. Evaluation (EDD, per root `AGENTS.md`)

This is an LLM-facing behavior change — per EDD rule 1, a failing eval scenario is written before implementation and must go green before merge. Needed scenarios (new or extended suite, implementation-time decision):

- `tool-call`/`tool-sequence` scenario: given a prompt needing an MCP tool outside the default set, the model calls `search_mcp_tools` then `use_mcp_tools` before attempting the real tool — not the real tool directly (which wouldn't be bound yet to fail against anyway, but the scenario should assert the discovery sequence happened).
- A scenario asserting an MCP tool *not* mentioned by name is **not** speculatively pulled in by a broad/unrelated search.

---

## Out of scope

- Skill-declared tool gating (#409) — the recurring/named-workflow case.
- Any new chat-UI surface.
- Fuzzy/partial matching, per-server browsing in `search_mcp_tools` beyond keyword substring.
- Wiring this into `bin/eval.ts` / the auto-eval harness's own middleware-independent code path beyond what EDD requires above, if that harness turns out to need separate plumbing the way issue #154's `filterHarnessSections` did (follow-up, not blocking this design, per the identical carve-out in the `#tool-name` design).

---

## See also

- GLOSSARY.md § MCP Tool Discovery (**MCP Tool Discovery**, **Discovered Tool**) and § Chat Turns & Context Trimming (**Turn**).
- ADR-0067 (default-off MCP binding + Turn-scoped discovery grant).
- `docs/superpowers/specs/2026-09-14-explicit-tool-syntax-design.md` (the `#tool-name` mechanism this design deliberately does not reuse or modify).
