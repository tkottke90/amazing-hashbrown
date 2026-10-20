# Skill Runtime Artifact Access — Design

Issue: [#319](https://github.com/tkottke90/amazing-hashbrown/issues/319)
Branch: `docs/319-skill-runtime-access-design`

## Problem

A skill's body is injected once, verbatim, when its slash command is invoked (`skill-expansion.middleware.ts`). Nothing lets a running skill read its own `references/*.md` content or run its own `scripts/*` at that point — a skill body that says "see references/operations.md" or "run scripts/check.py" is dead prose today. `SkillsManager.runScript`/`runPythonScript` already exist and are sandboxed, but the only production caller is `test_skill_artifact`, an authoring-time dry-run gated exclusively to `/create-skill`.

## Terminology and prior decisions

New vocabulary (Active Skill, Skill-Gated Tools, Skill-Scoped Tools, Skill Artifact, Artifact Index) is defined in `GLOSSARY.md` § "Skill Invocation & Runtime Access" — not restated here. The architectural decisions behind this design are recorded as ADR-0019 through ADR-0022 in `docs/adr/`; each section below names the ADR it implements rather than re-arguing it.

## Design

### Active Skill tracking broadens (ADR-0019)

`skill-expansion.middleware.ts` sets Active Skill (the state field currently named `activeGatedSkill`, renamed to reflect its broader role) for _every_ skill a slash command successfully resolves, not only the four in `GATED_SKILL_REGISTRATIONS`. `gatedSkillStateSchema` and its consumers (`skill-gated-tools.middleware.ts`, `gated-skill-registrations.ts`) are renamed to match but otherwise unchanged in behavior — Skill-Gated Tools still filters by exact skill-name match, so a skill with no registration continues to unlock nothing there.

Active Skill state stores only the skill's **name** — nothing about app-vs-workspace scope. Both new tools re-resolve `{manager, scope}` via the existing `resolveSkillScope(name, workspaceId)` at call time, the same way `test_skill_artifact`/`get_skill_source` already do. This avoids introducing a second place that needs to agree on scope resolution.

### Two new Skill-Scoped Tools

Neither tool takes a skill-name argument — "which skill" always resolves server-side from Active Skill, satisfying the issue's "no arbitrary cross-skill file access" criterion by construction rather than by convention.

- **`read_skill_reference({ name })`** — reads `references/<name>` for the Active Skill via `SkillsManager.readFile(activeSkill, 'references', name)`. Returns the file content, or a clear error if `name` isn't in that skill's `references/`.
- **`run_skill_script({ name, args? })`** — runs `scripts/<name>` for the Active Skill, dispatching on extension (`.py`, `.sh`, `.js`/`.mjs`/`.cjs`) the same way `test_skill_artifact` already does. Returns a `ScriptResult` (`stdout`/`stderr`/`exitCode`) uniformly across all three extensions (see below).

Both tools go through `resolveSkillScope`'s existing `not-found`/`ambiguous`/`found` handling for error messaging.

### Skill-Scoped Tools gating (ADR-0019, Design Needs §3)

A new, small middleware (`skill-scoped-tools.middleware.ts`, sharing the same renamed state schema) filters `['read_skill_reference', 'run_skill_script']` to visible-only-when-`activeSkill !== null`. This is a different shape than `skill-gated-tools.middleware.ts`'s per-skill registration map and is kept as its own middleware rather than folded into it, since "visible for any active skill" and "visible for one specific registered skill" are genuinely different filters (this is exactly the Skill-Gated-Tools-vs-Skill-Scoped-Tools distinction recorded in the glossary).

The same middleware's `wrapToolCall` hook is also how "which skill" reaches the tool handler without a model-supplied argument: it injects `activeSkill` into the tool call's own `args` (not `runtime.configurable`, which turned out not to propagate to the real handler — see ADR-0023). Both tools' zod schemas use `.passthrough()` so this extra key survives validation without being declared in the model-visible schema.

### Script execution unification (ADR-0020, ADR-0021)

- `lib/skills-manager/src/internal/runner.ts`'s `runJsScript` moves from `vm.runInContext` to a spawned `node <scriptPath> <args...>` process, returning `ScriptResult` instead of a bare value — bringing it in line with the Python path. The previously-documented `context` object is preserved but now serialized to JSON and delivered via an environment variable the script reads itself (e.g. `SKILL_SCRIPT_CONTEXT`), since a spawned process shares no memory with its parent.
- A shell path is added alongside the Python one (`sh "<scriptPath>" <args...>`), returning the same `ScriptResult` shape.
- A single configurable wall-clock timeout (new `AppConfigSchema`/`env.ts` field, e.g. `skillScriptTimeoutMs`, with a sensible default) is enforced on every spawned script execution — `.py`, `.sh`, and now `.js` alike — and applies uniformly to both the new runtime path and the existing `test_skill_artifact` dry-run path, per ADR-0021. The spawned process is killed on timeout; `ScriptResult` reports a non-zero/timeout exit status.
- `test_skill_artifact.tool.ts` is updated to add `.sh` dispatch and to drop its now-stale note that JS scripts have "no stdout capture" — that becomes false once `.js` runs via spawn too.

### Artifact Index (ADR-0022, Design Needs / AC4)

After expanding a skill's body, `skill-expansion.middleware.ts` appends a computed "Available Artifacts" section listing every file currently in the Active Skill's `scripts/`/`references/` (already available via `SkillsManager.inspect()`'s `scripts`/`references` key lists), each paired with its exact tool call:

```
## Available Artifacts
- Reference `operations.md` → call `read_skill_reference` with `name: "operations.md"`
- Script `check-status.sh` → call `run_skill_script` with `name: "check-status.sh"`
```

Omitted entirely when a skill has neither directory populated. Nothing is ever written back to `SKILL.md`.

`create-skill`'s own default body (`api/src/services/default-skills.ts`) is updated to mention that the Artifact Index is generated automatically, so its authoring guidance stops instructing authors to hand-write script/reference call-out prose.

### Workspace-scoped skills

No separate mechanism needed: Active Skill resolution and both new tools use the same `resolveSkillScope` path that already serves workspace (`.agents/skills`) skills for `test_skill_artifact`/`get_skill_source` today.

## Out of scope

Network egress restriction and CPU/memory resource caps on skill script execution are explicitly deferred — file as a separate follow-up issue once this lands. Timeout alone converts "a script can hang forever" into "a script is bounded," which is the urgent gap this issue closes; real sandboxing (process isolation, egress control) is its own design effort.

## Testing strategy

- **Unit**: `runner.ts` spawn-based execution for `.py`/`.sh`/`.js`, including timeout-triggered kill behavior (mock `child_process.spawn`); `SkillsManager` method coverage for the new/changed methods.
- **Orchestration**: `skill-expansion.middleware.ts` (Active Skill set for any resolved skill; Artifact Index present/omitted correctly); `skill-scoped-tools.middleware.ts` tool-visibility, mirroring the existing `skill-gated-tools.middleware.test.ts` pattern.
- **External-orchestration**: none — no new external HTTP boundary.
- **EDD**: the Artifact Index's exact wording is LLM-facing behavior per this repo's Evaluation-Driven Development rules. Before this is considered done, add a failing-then-passing eval scenario (new or extended `suites/*.yaml`, e.g. `suites/create-skill.yaml` or a new `suites/skill-artifact-access.yaml`) verifying a model actually calls `read_skill_reference`/`run_skill_script` correctly off the generated index. This environment has no network path to local model providers, so eval runs hand off to the user per the root `AGENTS.md`'s EDD rule 5.

## Acceptance criteria

- [ ] `read_skill_reference` reads the Active Skill's `references/` content, scoped only to that skill (no skill-name parameter)
- [ ] `run_skill_script` runs the Active Skill's `scripts/` (`.py`/`.sh`/`.js` family), scoped only to that skill, under a configurable timeout
- [ ] Both are Skill-Scoped Tools, visible whenever any skill is Active, and resolve app-vs-workspace scope via the existing `resolveSkillScope`
- [ ] Artifact Index is generated at invocation time (never authored into `SKILL.md`), and `create-skill`'s own guidance is updated accordingly
- [ ] One configurable timeout governs script execution everywhere, including the existing `test_skill_artifact` dry-run
- [ ] Network/resource sandboxing is explicitly out of scope here and filed as a separate follow-up issue
