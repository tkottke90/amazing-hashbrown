# Guided Skill Creation & Repair (`/create-skill`)

Design for a built-in, chat-invoked skill that guides an end user through
creating a new Agent Skill or repairing/upgrading an existing one — for
either the app-wide Skill Manager (`env.skillsRoot`) or a workspace's
`.agents/skills`.

## Problem

Agent Skills (`lib/skills-manager`, `api/src/services/skills-manager.ts`,
`api/src/services/workspace-skills.ts`) already have full manual authoring
support: a CRUD REST API and a Settings UI for app-level skills, and a
read-only `.agents/skills` overlay per workspace
(`docs/superpowers/specs/2026-09-26-repo-agent-skills-design.md`). None of
that is reachable from chat — the model's only skill-related tool today is
the read-only `search_skills` (`api/src/agents/tools/search-skills.tool.ts`).
A user who wants a new skill, or whose hand-written `SKILL.md` doesn't
trigger or parse the way they expect, has to leave the conversation and use
the Settings UI (app-level) or hand-edit files in their workspace checkout
(workspace-level) with no guidance on what "compatible with the system"
actually requires.

## Decisions

| Topic               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command surface     | One skill, `create-skill`, handles both fresh creation and repair/upgrade of an existing skill — the interview detects which from what the user says. Splitting into two commands would duplicate the interview phase for no benefit.                                                                                                                                                                                     |
| Target scope        | App-level (Skill Manager) and workspace-level (`.agents/skills`) are both supported. The flow **always asks explicitly** which scope to target via `ask_user`, never infers it from context — app-level and workspace-level skills can share a name, and a wrong guess is worse than one extra question.                                                                                                                  |
| Content scope (v1)  | `SKILL.md` (frontmatter + body) plus `scripts/` and `references/` artifacts. `evals/` is explicitly deferred — see **Out of scope**.                                                                                                                                                                                                                                                                                      |
| Interaction model   | A multi-turn guided interview driven by the `ask_user` tool (`api/src/agents/tools/ask-user.tool.ts`), following the same conventions already established by `create-workspace`/`create-project`: batch related fields into one combined question rather than one field at a time, use `free_text` for open-ended fields (never `multiple_choice` with invented examples), confirm with a `yes_no` call before any write. |
| Teaching            | The agent explains _why_ it's asking for each thing as it goes (what the description field drives, what makes a body "compatible"), rather than running silently and only producing a result.                                                                                                                                                                                                                             |
| Tool shape          | New, small, single-purpose tools rather than one generic parameterized tool — this repo's own `AGENTS.md` (§ Composition over Customization) calls out a generic `type`/config-bag tool as the anti-pattern to avoid.                                                                                                                                                                                                     |
| Gating              | All new tools are hidden by default and only visible while `create-skill` is the active skill, via the existing Skill-Gated Tools mechanism (`skill-gated-tools.middleware.ts`, `gated-skill-registrations.ts`) — the same pattern `create_workspace`/`create_project`/`propose_file_merge` already use.                                                                                                                  |
| Reservation         | `create-skill` is added to `GATED_SKILL_REGISTRATIONS`, which `resolveWorkspaceSkills` already maps into its `reserved` list automatically — a workspace repo can never ship its own `.agents/skills/create-skill/SKILL.md` and hijack these tools.                                                                                                                                                                       |
| Repair reactivity   | Reactive only: repair acts on a skill the user names. No proactive "scan everything and flag what's broken" audit feature in v1.                                                                                                                                                                                                                                                                                          |
| Collision check     | On **creation**, check both scopes for a name/slash-command collision and warn before writing, even though the target scope was already chosen explicitly — knowing the target doesn't tell the user whether they're about to shadow, or be shadowed by, a same-named skill in the other scope.                                                                                                                           |
| Compliance check    | Repair reuses the real frontmatter/boot-time validation logic (the same checks `SkillsManager.boot()` already runs) to produce a concrete list of what's wrong, rather than the model guessing from the raw text.                                                                                                                                                                                                         |
| Workspace writes    | Written straight to disk in `.agents/skills`, **never auto-committed**. The user reviews and commits through their normal workspace git flow, same as any other workspace file change.                                                                                                                                                                                                                                    |
| Script risk         | No separate "this is executable code" confirmation step beyond the normal draft-review confirmation — treated as implied by the existing skill model rather than a bespoke gate for this flow.                                                                                                                                                                                                                            |
| Script sanity check | After writing a script artifact, the flow offers to dry-run it immediately (`test_skill_artifact`) so a broken script surfaces during the guided flow, not the next time the skill is invoked for real.                                                                                                                                                                                                                   |

## Flow

1. **Scope.** Ask (via `ask_user`, `yes_no` or `multiple_choice`) whether this
   is about the app-wide Skill Manager or the current workspace's
   `.agents/skills`. If there is no workspace in play (plain chat), app-level
   is the only option and this step is a statement, not a question.
2. **Create vs. repair.** If the user named an existing skill or described a
   problem with one, this is repair: call the new read tool (see below) to
   fetch its current `SKILL.md`, scripts, and references, plus a structured
   list of compliance issues. Otherwise this is creation.
3. **Interview.** Collect name, description (and explain that this is the
   literal trigger text `search_skills` and the slash menu match against —
   it needs concrete phrases a user would actually type, not a vague
   summary), body, and whether any scripts or reference files are needed.
   Batch related questions per the existing `ask_user` convention. For
   repair, frame this around the compliance issues already found, plus
   whatever the user actually wants changed.
4. **Collision check (creation only).** Look up the chosen name/slash
   command in _both_ scopes (the existing `search_skills` tool is already
   scope-aware and merge-marks `overrides`, so this likely needs no new
   tool — see **Open implementation notes**). If found in the other scope,
   tell the user what will shadow or be shadowed, and let them rename or
   proceed.
5. **Draft and confirm.** Summarize the full draft (frontmatter + body, and
   any planned scripts/references) and get an explicit `yes_no` confirmation
   before writing anything — same checkpoint discipline as
   `create-workspace`/`create-project` step 3.
6. **Write.** Call `create_app_skill`/`edit_app_skill` or
   `create_workspace_skill`/`edit_workspace_skill` for the `SKILL.md`
   content, then `create_skill_artifact`/`update_skill_artifact`/
   `delete_skill_artifact` for any script/reference files.
7. **Dry run.** For a script artifact, offer `test_skill_artifact` and show
   the result (stdout/stderr/exit code) before ending the flow.
8. **Wrap-up.** For a workspace write, remind the user the file is on disk
   but not committed. For an app-level write, the skill now shows up in the
   Skill Manager and slash menu immediately (same as a manual create/edit
   through the existing CRUD routes).

## New tools

All gated behind `create-skill` via `GATED_SKILL_REGISTRATIONS`, following
the `makeCreateWorkspaceTool`-style factory pattern
(`api/src/agents/tools/create-workspace.tool.ts`) so each is independently
testable against a real `SkillsManager` over a temp directory rather than a
module-level singleton.

| Tool                     | Signature (sketch)                                                                | Backs onto                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_app_skill`       | `(name, description, body, license?, compatibility?, metadata?, allowedTools?)`   | `skillsManager.create()` — same `CreateSkillInput` the REST route already validates against (`api/src/routes/v1/skills.handlers.ts`'s `CreateSkillSchema`)                                  |
| `edit_app_skill`         | `(name, description?, body?, license?, compatibility?, metadata?, allowedTools?)` | `skillsManager.edit()` / `EditSkillInput`                                                                                                                                                   |
| `create_workspace_skill` | `(name, description, body, ...)`                                                  | Same shape, but resolved against the current workspace's `.agents/skills` directory directly (not through the read-only `resolveWorkspaceSkills` child — see **Open implementation notes**) |
| `edit_workspace_skill`   | `(name, description?, body?, ...)`                                                | Same, workspace-scoped                                                                                                                                                                      |
| `get_skill_source`       | `(name)` — scope is whichever was established in step 1 of this flow              | Returns the full `Skill` (frontmatter, body, script/reference filenames) plus a structured compliance report reusing the same validation `boot()` already runs                              |
| `create_skill_artifact`  | `(skill, type: 'script' \| 'reference', name, content)`                           | `skillsManager.writeFile(skill, type === 'script' ? 'scripts' : 'references', name, content)`, guarded to fail if the file already exists                                                   |
| `update_skill_artifact`  | `(skill, type: 'script' \| 'reference', name, content)`                           | Same `writeFile`, overwrite semantics                                                                                                                                                       |
| `delete_skill_artifact`  | `(skill, type: 'script' \| 'reference', name)`                                    | New `deleteFile` on `SkillsManager` (doesn't exist yet — `delete()` today only removes a whole skill directory)                                                                             |
| `test_skill_artifact`    | `(skill, name, args?)`                                                            | `skillsManager.runScript()` or `runPythonScript()`, selected by `name`'s extension — the first tool to expose either method to the model at all                                             |

Naming deliberately distinguishes `test_skill_artifact` from a hypothetical
"run" tool, so the model doesn't read it as how a skill's script gets
invoked for real — it's a sanity check during authoring, not an invocation
path.

## Validation & collision checking

- **Compliance check** (repair): `get_skill_source` runs the skill's
  frontmatter through the same parser/validator `SkillsManager.boot()` uses,
  plus the `name`-matches-directory check, and reports both — rather than
  only surfacing problems when a later write is attempted.
- **Write-time validation** (both create and repair): `create_app_skill` /
  `edit_app_skill` reuse `skillsManager.create()`/`edit()` directly, so they
  inherit the exact same validation the manual Settings UI flow already
  gets — no parallel validation logic to keep in sync.
- **Cross-scope collision check** (creation): reuses `search_skills`'s
  existing scope-aware lookup (global ∪ workspace overlay, `overrides`
  flagged) rather than a new dedicated tool.

## Gating & reservation

```ts
// api/src/agents/gated-skill-registrations.ts
export const GATED_SKILL_REGISTRATIONS: SkillGatedToolRegistration[] = [
  { skillCommand: 'create-workspace', toolNames: ['create_workspace'] },
  { skillCommand: 'create-project', toolNames: ['create_project'] },
  { skillCommand: 'resolve-file-conflict', toolNames: ['propose_file_merge'] },
  {
    skillCommand: 'create-skill',
    toolNames: [
      'create_app_skill',
      'edit_app_skill',
      'create_workspace_skill',
      'edit_workspace_skill',
      'get_skill_source',
      'create_skill_artifact',
      'update_skill_artifact',
      'delete_skill_artifact',
      'test_skill_artifact',
    ],
  },
];
```

This single array is still the one source of truth both
`skill-expansion.middleware.ts` (opens the gate) and
`skill-gated-tools.middleware.ts` (filters the tool list) read from, and
`resolveWorkspaceSkills` already derives its `reserved` list from the same
array — adding this entry reserves `create-skill` automatically, with no
separate change needed in `workspace-skills.ts`.

## `create-skill` as a `DEFAULT_SKILL`

Seeded in `api/src/services/default-skills.ts` alongside `create-workspace`,
`create-project`, and `resolve-file-conflict`. Its body needs the same
treatment those three already went through: an initial draft, then
iterative tightening against real eval runs (`suites/*.yaml`) as concrete
model failure modes surface — e.g. a model skipping the scope question, or
inventing a plausible-looking description instead of asking what the skill
should actually trigger on. That tightening is implementation work, not a
design decision, and isn't attempted here; the flow in this document is the
contract the body text has to encode, not the body text itself.

## Testing

Tags per root `AGENTS.md`. Unit unless marked.

### Library (`lib/skills-manager`, Mocha)

- `SkillsManager.deleteFile()` (new) removes the named script/reference
  file; throws on a read-only manager before touching disk, matching every
  other write method's `assertWritable()` guard.
- `runScript`/`runPythonScript` return value shape is unchanged — no new
  library behavior needed for the dry-run tool beyond what already exists.

### API (Mocha)

- Each new tool `[unit]`: constructed with a fake/temp-dir-backed
  `SkillsManager` (or workspace resolver), asserting the right manager
  method is called with the right arguments and the right `ToolMessage`/
  `Command` shape comes back — same style as
  `create-workspace.tool.test.ts`.
- `create_app_skill`/`create_workspace_skill` reject a name collision in
  the _other_ scope with a message naming the conflict, not a silent
  success `[orchestration]`.
- `get_skill_source` on a skill with invalid frontmatter returns the raw
  content plus a non-empty compliance report rather than throwing.
- Gating: `create-skill`'s tools are absent from the model's tool list
  until the skill is active, then present — same assertion shape as the
  existing `skill-gated-tools.middleware.test.ts` cases for the other three
  registrations.
- Reservation: a workspace `.agents/skills/create-skill/SKILL.md` is
  skipped at boot with reason `reserved`, mirroring the existing
  `create-project`/`create-workspace` reservation tests in
  `workspace-skills.test.ts`.

### E2E (Playwright, `@user-workflow`, CI-safe, no LLM)

- Mock the `ask_user` HITL SSE sequence (per `e2e/AGENTS.md`'s SSE-mocking
  pattern) to drive a scripted creation flow end to end and assert the new
  skill appears in the Skill Manager / slash menu afterward.
- A workspace-scoped run asserts the new `.agents/skills/<name>/SKILL.md`
  file exists on disk and that the workspace's git status shows it as an
  uncommitted addition (not auto-committed).

### Evaluations

Per root `AGENTS.md`'s EDD rule 1 — this is a new LLM-facing feature, so a
failing eval scenario comes first, then the `create-skill` skill body is
implemented/tightened against it, the same way `create-workspace`/
`create-project` were. At minimum: a creation scenario per scope, a repair
scenario that starts from a skill with a real compliance problem, and a
collision scenario (same name already exists in the other scope).

## Out of scope

- `evals/` authoring support (walking the user through writing
  `EvalCase`/`EvalSuite` content for their new skill). Tracked separately —
  before filing, confirm the "v1.11.0 - In-App Evaluations" milestone
  referenced for this actually exists in the repo's GitHub milestones.
- Proactive bulk audit of existing skills for compliance issues.
- Deleting an entire skill (the existing Settings UI delete already covers
  this; repair here is always edit-in-place).
- Auto-committing workspace writes, or any other git automation.
- A distinct "this writes executable code" confirmation step beyond the
  normal draft-confirmation gate.
- Enforcement of the `allowed-tools` frontmatter field — it is parsed and
  stored today but not enforced anywhere at runtime
  (`lib/skills-manager/src/types.ts:7`, "enforcement deferred until
  tools-manager is built"); `/create-skill` captures it as an optional field
  like any other but makes no claim that setting it restricts anything yet.

## Open implementation notes (flagged for review, not decided here)

- **Workspace write path.** `resolveWorkspaceSkills`'s child `SkillsManager`
  is deliberately read-only (`createChild(..., { reserved })`,
  `assertWritable()` throws on every write/script method). `create_workspace_skill`/
  `edit_workspace_skill`/the artifact tools for workspace scope therefore
  need to construct a _separate_, writable `SkillsManager` rooted at
  `<workspace.location>/.agents/skills` (via the plain constructor, not
  `createChild`) rather than going through the resolver used for reads. This
  mirrors how reads and writes already diverge for the global manager vs.
  its children; flagging it explicitly since it's not spelled out in the
  decisions table above.
- **Artifact tool scope resolution.** `create_skill_artifact` et al. take
  `skill: string` with no explicit scope parameter, per the signature given
  during design. This only resolves unambiguously because a single
  `create-skill` session works on exactly one skill, in exactly one
  already-chosen scope, at a time — the tools are expected to resolve
  against whichever manager (app or workspace) was selected in step 1 of
  that session, not re-derive scope per call. Worth a second look if a
  future session needs to juggle more than one skill at once.
