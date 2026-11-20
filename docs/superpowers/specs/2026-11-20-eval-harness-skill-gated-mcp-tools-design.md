# Eval Harness Support for Skill-Gated MCP Tools — Design

**Date:** 2026-11-20
**Status:** Draft
**Related:** [Issue #432](https://github.com/tkottke90/amazing-hashbrown/issues/432) (depends on #409 / PR #431)

---

## Goal

Let an eval scenario declare a synthetic MCP tool that's already bound via Skill-Gated Tools (PR #431's MCP half, `api/src/agents/skill-gated-mcp-tools.middleware.ts`), so the harness can assert the model calls it directly on the first attempt — no `search_mcp_tools`/`use_mcp_tools` detour — and, separately, that an admin's explicit disable (ADR-0074) still wins even while the gating skill is Active.

## Problem

See issue #432 for the full write-up: `lib/evaluations/src/runner.ts`'s `SkillGatedToolsMiddlewareLike` slot in `RunConfig` is filter-only — it matches `skill-gated-tools.middleware.ts`'s built-in half, which only ever removes tools from an already-full candidate list. PR #431's MCP half (`skill-gated-mcp-tools.middleware.ts`) works the opposite way: it **adds** a tool that isn't in the candidate list by default. There's no `RunConfig` slot for that kind of middleware, and no mechanism for a `gatedSkill` scenario to supply a tool candidate outside the static `evalTools` fixture list — so this new, model-facing behavior from #409/#431 is untestable today, in violation of root `AGENTS.md`'s EDD rule 1.

**Wrinkle found while designing this:** the real middleware's ADR-0074 enforcement (`getGloballyEnabledToolIds`) reads from the real, sqlite-backed `ToolSettingsStore` **singleton** — its `store` parameter isn't reachable through the middleware factory's own injectable `getToolsConfig` argument. `bin/eval.ts` never boots a `ToolSettingsStore` today. Calling the real middleware unmodified therefore requires the harness to also boot one — ephemerally, per run, the same way it already seeds a disposable `SkillsManager` instead of reusing the persistent one (see `bin/eval.ts`'s "Hermetic per-run skill seeding" comment).

---

## Decisions (settled via brainstorming)

| Question                                           | Decision                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does the synthetic MCP tool come from        | Scenario-declared, not a hardcoded fixture. A new `gatedMcpTools` YAML field lets a scenario describe its own tool(s) inline.                                                                                                                                                                                                                      |
| Where does the skill→tool _registration_ come from | Also scenario-declared. The scenario supplies both the tool and which `gatedSkill` it's registered under, standing in directly for `resolveSkillGatedRegistrations`'s output — it does not need a real skill in `evalSkillsManager`, nor exercise skill-frontmatter resolution end to end (that's already covered by `skill-tool-gating.test.ts`). |
| Real middleware vs. harness reimplementation       | Call the real, unmodified `createSkillGatedMcpToolsMiddleware` from `api/src/agents/skill-gated-mcp-tools.middleware.ts`. No production code changes.                                                                                                                                                                                              |
| ADR-0074 enforcement (`ToolSettingsStore`)         | Boot a fresh, ephemeral `ToolSettingsStore` once per `bin/eval.ts` process (temp-dir sqlite, same lifecycle as the existing ephemeral `SkillsManager`), seeded from every scenario's declared tools before any suite runs. Never touches the real app database.                                                                                    |
| Suite placement                                    | Append to `suites/mcp-tool-discovery.yaml` as the direct-bind complement to `mtd-001`'s discovery-then-grant case.                                                                                                                                                                                                                                 |
| ADR-0074 scenario                                  | In scope. A second new scenario covers "admin disabled, skill still Active ⇒ tool stays unbound," the one branch of `createSkillGatedMcpToolsMiddleware` otherwise only covered at the unit level (`skill-gated-mcp-tools.middleware.test.ts`), never by real model behavior.                                                                      |

---

## Architecture

### 1. Scenario schema — `lib/evaluations/src/schemas.ts`

One new optional field, parallel to the existing `gatedSkill`, added to both `ToolCallScenarioSchema` and `ToolSequenceScenarioSchema`:

```ts
const GatedMcpToolField = z
  .object({
    toolId: z.string().min(1), // display id, e.g. "n8n:workflow_search"
    description: z.string().min(1),
    // Raw JSON-Schema object for the tool's args — same convention
    // StructuredScenarioSchema.outputSchema already uses, not a zod schema.
    argsSchema: z.record(z.string(), z.unknown()).optional(),
    // Models ADR-0074's admin-disable override. Defaults true (the
    // ordinary "skill gates it, nothing overrides" case).
    enabled: z.boolean().default(true),
  })
  .strict();

const GatedMcpToolsField = z.array(GatedMcpToolField).min(1).optional();
```

A scenario sets this alongside the existing `gatedSkill` field. `gatedSkill` names the skill; `gatedMcpTools` is what that skill is declared to gate — the scenario's own stand-in for a skill's `tools` frontmatter, scoped to the MCP half only. Both fields stay independently optional, so every existing `gatedSkill` scenario (`create-workspace-project.yaml` etc., which only ever gate built-ins) is untouched.

### 2. Runner — `lib/evaluations/src/runner.ts`

**New structural type.** The real `createSkillGatedMcpToolsMiddleware`'s returned `wrapModelCall` shape is identical to the existing `SkillGatedToolsMiddlewareLike` (same `request: { tools, state: { activeSkill } }` / `handler` contract — filtering and adding differ only in what the handler is called with, not the type). Reused as-is, no duplicate interface.

What differs is that this middleware's _registration_ is scenario-specific, unlike the other three `RunConfig` middlewares, which are built once per run against the real `evalSkillsManager`/`env.tools`. So `RunConfig` takes the **factory function** itself, not a pre-built instance:

```ts
export interface SkillGatedMcpToolsMiddlewareFactoryLike {
  (
    mcpTools: BindToolsInput[],
    getSkills: () => { list: () => Array<{ name: string; tools?: string }> },
    getToolsConfig: () => Record<string, { enabled?: boolean }>,
  ): SkillGatedToolsMiddlewareLike;
}
```

Added to `RunConfig` as `skillGatedMcpToolsMiddlewareFactory?: SkillGatedMcpToolsMiddlewareFactoryLike`, with a doc comment explaining the factory-vs-instance distinction from the other three middleware fields.

**New helper**, sibling to the existing `resolveGatedTools()`:

```ts
async function resolveGatedMcpTools(
  tools: BindToolsInput[],
  activeSkill: string | null,
  gatedSkill: string,
  gatedMcpTools: GatedMcpTool[], // the scenario's declared entries
  factory: SkillGatedMcpToolsMiddlewareFactoryLike,
): Promise<BindToolsInput[]>;
```

It:

1. Builds one `ClientTool`-shaped `BindToolsInput` per `gatedMcpTools` entry — `name` is the bound form of `toolId` (colon → double underscore; a one-line local conversion, not an import of `api/src`'s `toBoundMatchKeys`, matching how `toolName()` is already a small local helper in this file rather than a cross-package import), `description` passed through, `schema` from `argsSchema` (or a permissive empty-object schema when omitted).
2. Builds a synthetic registration: `getSkills: () => ({ list: () => [{ name: gatedSkill, tools: gatedMcpTools.map(t => t.toolId).join(',') }] })`.
3. Builds `getToolsConfig: () => Object.fromEntries(gatedMcpTools.map(t => [t.toolId, { enabled: t.enabled }]))` — this is what lets a scenario express the ADR-0074 override.
4. Calls `factory(mcpClientTools, getSkills, getToolsConfig)`, then runs the result through the same capture-via-handler pattern `resolveGatedTools()` already uses.

**Wiring.** In the `tool-call` and `tool-sequence` branches of `executeScenario`, immediately after the existing `resolveGatedTools()` call (i.e., after the built-in filter has already run), add:

```ts
if (s.gatedMcpTools) {
  if (!config.skillGatedMcpToolsMiddlewareFactory) {
    throw new Error(
      `scenario "${s.id}" sets gatedMcpTools but no skillGatedMcpToolsMiddlewareFactory was provided in RunConfig`,
    );
  }
  toolsForCall = await resolveGatedMcpTools(
    toolsForCall,
    resolved.activeSkill,
    s.gatedSkill!,
    s.gatedMcpTools,
    config.skillGatedMcpToolsMiddlewareFactory,
  );
}
```

Both branches require `s.gatedSkill` whenever `s.gatedMcpTools` is set — enforced by a loader-level check (`validateScenarioTurns`'s neighborhood in `loader.ts`, same place today's turns/steps cross-field checks live), not by the zod schema itself, consistent with how other cross-field scenario rules are already validated in this codebase.

### 3. `bin/eval.ts` / `bin/eval-setup.ts`

- **Ephemeral `ToolSettingsStore`.** Once per process, alongside the existing ephemeral `SkillsManager` setup: `mkdtemp` a temp dir, `openDatabase` a fresh sqlite file in it, `bootToolSettingsStore(db)`. Never points at `env.database.path` — this store exists purely so `getGloballyEnabledToolIds()`'s default `store` argument (unreachable through the middleware factory itself) resolves against _something_ that reflects this run's scenarios, never the real app's tool settings.
- **Seeding.** Before any suite runs, walk every scenario in every suite about to run (the single named suite, or all of them in the no-`--suite` sweep), collect every `gatedMcpTools[].toolId`, dedupe, and call `getToolSettingsStore().recordMcpDiscoveryResult(...)` once per distinct id — `mcpServer` parsed from the id's prefix (text before the colon), `connected` status, mirroring exactly what `skill-gated-mcp-tools.middleware.test.ts` already does by hand for its own fixture. This establishes "exists, enabled by default"; a scenario's own `enabled: false` override (passed through `getToolsConfig` per call, per §2 step 3) is what then actually disables it for that scenario, same two-layer resolution `resolveToolSettings` already implements for real tools.
- **Bridging.** `createSkillGatedMcpToolsMiddleware` is imported unchanged from `api/src/agents/skill-gated-mcp-tools.middleware.ts` and passed into `runEval`'s `skillGatedMcpToolsMiddlewareFactory` with the same single-point `as unknown as SkillGatedMcpToolsMiddlewareFactoryLike` cast the other three middlewares already use — no production code touched.

### 4. New scenarios — append to `suites/mcp-tool-discovery.yaml`

```yaml
- id: mtd-003-skill-gated-mcp-tool-called-directly
  name: 'An MCP tool already bound via Skill-Gated Tools is called directly, with no discovery round-trip'
  purpose: >
    The complementary case to mtd-001: #409/#431 lets a skill's own `tools`
    frontmatter field gate an MCP tool directly, binding it the instant the
    skill is Active, with no search_mcp_tools/use_mcp_tools step at all.
    Confirms the model treats an already-bound skill-gated MCP tool like
    any other available tool, rather than reflexively running the newer
    discovery-first habit mtd-001/mtd-002 exist to establish.
  type: tool-call
  input: >
    Use the n8n workflow-search tool to find workflows related to
    "invoice processing".
  gatedSkill: n8n-workflow-sync
  gatedMcpTools:
    - toolId: 'n8n:workflow_search'
      description: 'Search n8n workflows by keyword'
      argsSchema:
        type: object
        properties:
          keyword: { type: string }
        required: [keyword]
  tool: n8n__workflow_search

- id: mtd-004-admin-disable-overrides-skill-gate
  name: "An admin's explicit disable keeps a skill-gated MCP tool unbound even while its skill is Active"
  purpose: >
    ADR-0074: skill-gating an MCP tool is not a full Tool Access exemption
    the way a built-in skill-gated tool gets — an admin's explicit disable
    still wins. Only skill-gated-mcp-tools.middleware.test.ts covers this
    today, at the unit level; this is the first check against real model
    behavior.
  type: tool-call
  input: >
    Use the n8n workflow-search tool to find workflows related to
    "invoice processing".
  gatedSkill: n8n-workflow-sync
  gatedMcpTools:
    - toolId: 'n8n:workflow_search'
      description: 'Search n8n workflows by keyword'
      enabled: false
      argsSchema:
        type: object
        properties:
          keyword: { type: string }
        required: [keyword]
  tool: '!n8n__workflow_search'
```

`n8n-workflow-sync` and `n8n:workflow_search` reuse the exact fixture identity `skill-gated-mcp-tools.middleware.test.ts` already established for this feature — no new naming convention introduced. The suite's `purpose` field gets one added sentence noting it now also covers the direct-bind (skill-gated) path alongside pure discovery.

---

## Testing

Per root `AGENTS.md`:

- **Unit** (`runner.test.ts`): `resolveGatedMcpTools()` — bound-name conversion, registration/`getToolsConfig` construction from a `gatedMcpTools` array, the "factory missing" throw.
- **Orchestration** (`runner.test.ts`): the `tool-call`/`tool-sequence` branches' new conditional, spying on a fixture factory the same way the existing `resolveGatedTools`-adjacent branches are already tested — never a real sqlite store or real `createSkillGatedMcpToolsMiddleware` at this tier.
- **E2E-equivalent (eval)**: `mtd-003`/`mtd-004` themselves are the EDD coverage this issue exists to unblock — not developer tests, but the thing root `AGENTS.md`'s EDD section requires before #409/#431's MCP-gating behavior can be considered done. Per the EDD handoff rule, these are written and left for the user to run (`npm run eval -- --suite mcp-tool-discovery --model <provider> --judge-model <provider>`); not executed or reported as passing from this session.
- No changes to anything under `api/src/agents/` — the `ToolSettingsStore` seeding and middleware bridging are entirely `bin/eval.ts`-side, so no existing production test needs updating.

## Out of scope

- Any change to `createSkillGatedMcpToolsMiddleware`, `skill-tool-gating.ts`, or any other production file under `api/src/agents/` — this is purely eval-harness plumbing.
- Exercising the full skill-frontmatter → `resolveSkillGatedRegistrations` resolution chain through a real `evalSkillsManager`-seeded skill. That chain is already covered by `skill-tool-gating.test.ts`; this issue's scenarios test model behavior given an already-resolved binding, matching `mcp-tool-discovery.yaml`'s own stated purpose ("no real MCP server is needed... tool-call/tool-sequence scenarios only inspect the model's proposed tool_calls").
- A `tool-sequence`-shaped version of `mtd-003`/`mtd-004` (e.g. seeding a prior unrelated turn first). `tool-call` is sufficient for what this issue's acceptance criteria asks; `gatedMcpTools` is still added to `ToolSequenceScenarioSchema` for parity (so a future suite can use it on either scenario type without a follow-up schema change), but no `tool-sequence` scenario is authored here.

## See also

- `docs/superpowers/specs/2026-11-19-skill-config-tool-gating-design.md` (the design whose "Evaluation (EDD)" section named this issue as the follow-up).
- `docs/superpowers/specs/2026-11-11-mcp-tool-discovery-design.md` (the suite this issue extends; `mtd-001`/`mtd-002`'s own design).
- GLOSSARY.md § Skill Invocation & Runtime Access (**Skill-Gated Tools**, **Skill Tools Field**) and § MCP Tool Discovery (**Discovered Tool**).
- ADR-0074 (skill-gated MCP tools still respect an admin's explicit disable).
