# Repository Agent Skills (`.agents/skills/`)

Design for [issue #193](https://github.com/tkottke90/amazing-hashbrown/issues/193):
honor Agent Skills shipped inside a workspace's directory (typically its
attached git repository).

## Problem

A workspace with a git remote is cloned into `workspace.location`
(`workspace-provision.ts`). If that repository — or any workspace directory —
ships Agent Skills, the agent ignores them: skills come from exactly one global directory
(`env.skillsRoot`), served by a single `SkillsManager` singleton
(`api/src/services/skills-manager.ts`). Repo owners have no way to give the
agent codebase-specific slash commands.

## Decisions (and where they deviate from the issue)

| Topic                | Decision                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discovery path       | `<workspace.location>/.agents/skills/<name>/SKILL.md`. The issue says `.agents/<name>/`; the ecosystem convention (and this repo's own dev skills) is `.agents/skills/`. Scanning `.agents/` directly would collide with other tooling's files there.                                                                                                                                |
| Which workspaces     | Every workspace with a `location`, regardless of `remoteUrl`. The issue scopes this to GitHub-attached workspaces, but skills are read from local disk, not the GitHub API, so a `remoteUrl` gate would add no security (a stranger's cloned repo passes it; a hand-built local directory fails it) and would silently ignore skills in local-only or later-`git init`ed workspaces. |
| Trust / capabilities | **Instructions only.** Repo skills expand as slash commands and appear in `search_skills`. Their `scripts/` are never executable through `SkillsManager`. No opt-in step.                                                                                                                                                                                                            |
| Name collisions      | Repo skill wins, **except** reserved names (every gated-skill command in `gated-skill-registrations.ts`), where the global skill always wins and the repo skill is skipped.                                                                                                                                                                                                          |
| Visibility           | Slash menu only: a `repo` badge, plus `overrides global` when a repo skill replaces a global one. Skipped skills are logged server-side as warnings.                                                                                                                                                                                                                                 |
| Architecture         | Parent/child `SkillsManager`s: `skillsManager.createChild(dir, options)` returns a read-only child that resolves its own directory first and falls through to the parent.                                                                                                                                                                                                            |
| Freshness            | No caching. A child is created and booted per request, so git sync, branch checkout, and hand edits in the clone are reflected immediately.                                                                                                                                                                                                                                          |

### Why instructions-only removes the need for a trust gate

- Skill text only enters the conversation when the **user** types the slash
  command. The agent could already read any file in the clone via `shell_exec`,
  so exposing a `SKILL.md` body adds no new read capability.
- Scripts are the real risk: the executor wired into `SkillsManager` is
  created with `trustAll: true` (`api/src/index.ts`) and set as a
  **module-level** runner (`lib/skills-manager/src/internal/runner.ts`), and
  the JS runner exposes `process.env`. A repo script reaching that path would
  be arbitrary code execution from a cloned repository. Children refuse all
  script execution before reaching the runner.
- If a repo skill's instructions tell the agent to run a command, it goes
  through `shell_exec` and its normal allow/deny/approval policy.

### Why gated names are reserved

`skill-expansion.middleware.ts` opens a gate (`activeGatedSkill`) by command
**name**. Without reservation, a repo shipping
`.agents/skills/create-project/SKILL.md` would have its own instructions
running while the privileged `create_project` tool is exposed.

## Section 1 — Library (`lib/skills-manager`)

### `createChild(dir, { source, reserved }): SkillsManager`

- Returns a new `SkillsManager` with `parent = this` and `readOnly = true`,
  rooted at `dir`. Unbooted; callers `await child.boot()` before use.
- `source: string` labels the child's summaries (e.g. `'repo'`). A manager
  created with the plain constructor has source `'global'`.
- `reserved: string[]` names the child must never serve; they are skipped at
  boot.
- Nesting (child of a child) works by construction but nothing depends on it.

### Reads fall through, writes throw

- **Reads** — `lookup`, `load`, `readFile`, `loadEvals`: if the child's cache
  has the name, resolve against the child's root; otherwise delegate to the
  parent. If neither has it: the existing `Skill "x" not found` error.
- **`list()` / `search()`** — parent results minus names the child overrides,
  plus the child's own. `search()` keeps its existing enabled-only filter.
  Every `SkillSummary` gains `source: string`; a child summary whose name
  exists in the parent also gains `overrides: true`.
- **Writes and execution** — `create`, `edit`, `delete`, `writeFile`,
  `deleteFile`, `saveEvals`, `runScript`, `runPythonScript` on a read-only
  manager throw `Skill manager for <dir> is read-only` as the **first
  statement** of the method: before any path is built or the runner is
  reached, and even when the named skill belongs to the parent (a
  workspace-scoped handle can never mutate a global skill).

### `boot()` reports what it skipped

`boot()` returns `{ skipped: Array<{ dir: string; reason: SkipReason; detail?: string }> }`
instead of `void`. Existing callers that ignore the return value are
unaffected.

| `reason`              | When                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `invalid-frontmatter` | `parse`/`validateFrontmatter` throws; `detail` carries the error message.          |
| `name-mismatch`       | Frontmatter `name` ≠ directory name. Applies to **all** managers, global included. |
| `reserved`            | Child only; the name is in `reserved`.                                             |

`name-mismatch` fixes a latent bug: the cache is keyed by frontmatter `name`
but `lookup()` builds the path from that name as if it were the directory, so
a mismatched skill appears in the menu and then fails with "not found". The
Agent Skills spec requires them to match. A mismatched global skill that
"loads" today stops appearing — it was already unusable.

### Disabled child skills

A child skill with `metadata.enabled: 'false'` is treated as absent: the
parent's same-named skill shows through. "Disabled" means "not there".

## Section 2 — API wiring

### `resolveWorkspaceSkills(workspaceId)` — `api/src/services/workspace-skills.ts`

The single owner of the policy:

1. Load the workspace from the store on every call (so `location` edits take
   effect immediately). Unknown id → `NotFound`.
2. Empty `location` → return the global `skillsManager` (identical to today).
3. Otherwise build
   `skillsManager.createChild(join(location, '.agents', 'skills'), { source: 'repo', reserved })`,
   `await child.boot()`, log each `skipped` entry at warn level (workspace id,
   dir, reason, detail), and return the child.
4. `reserved` is derived from the gated-skill registrations list
   (`gated-skill-registrations.ts`, mapped to `skillCommand`), so future gated
   skills are protected automatically.

Return type: `Pick<SkillsManager, 'list' | 'search' | 'lookup'>`.

### Consumers become factories

Today the expansion middleware and `searchSkillsTool` are module-level
singletons bound to the global manager (`chat-agent.ts`). Both take a
`getSkills: () => Promise<Pick<SkillsManager, 'list' | 'search' | 'lookup'>>`
instead, mirroring the existing `makeShellExecTool(location)` pattern:

- `createSkillExpansionMiddleware(registrations, getSkills)` — calls
  `getSkills()` **only** when the latest human message starts with `/`;
  ordinary turns never touch disk.
- `makeSearchSkillsTool(getSkills)` — replaces the static `searchSkillsTool`
  entry in `STATIC_CHAT_TOOLS`.
- `buildWorkspaceChatAgent`, `buildTaskAgent`, and `buildSubAgentAgent`
  (all receive a workspace) pass `() => resolveWorkspaceSkills(workspace.id)`.
  Agents with no workspace pass `async () => skillsManager`.
- The per-workspace agent cache (`workspaceId:provider:model`) caches the
  closure, not the skills, so each invocation still reads fresh from disk.

The workspace is captured at agent-build time rather than read from
`runtime.configurable` inside `beforeAgent`, so the design does not depend on
what that hook's runtime argument exposes.

### Route — `GET /api/v1/workspaces/:id/skills?q=`

Returns `{ skills: SkillSummary[] }` from `resolveWorkspaceSkills(id).search(q)`
— same query semantics and response shape as `GET /api/v1/skills`, plus the
`source` / `overrides` fields. Unknown workspace → 404. The global
`/api/v1/skills` routes are unchanged.

### Error handling

| Situation                                    | Result                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `.agents/skills` missing                     | Empty child; global skills only (existing `scanSkillsRoot` catch). |
| `location` missing / unreadable              | Same as above; no error surfaced.                                  |
| Malformed / mismatched / reserved repo skill | Skipped and logged; never fails the turn or the request.           |
| Write or script call on a child              | Throws `read-only` before any side effect.                         |

Skip warnings are logged on every resolve (every menu fetch and slash command
in that workspace). Noisy for a broken repo, but accurate and self-clearing
once fixed; no dedup (YAGNI).

## Section 3 — UI

- `ChatInput` gains an optional `workspaceId` prop. When set, the slash menu's
  fetch uses `GET /api/v1/workspaces/:id/skills?q=`; otherwise the existing
  global endpoint. Only `workspace-chat-tab.tsx` passes it — general chat and
  wiki ingestion chat are unchanged.
- `SkillInfo` (`ui/src/services/skills-api.ts`) gains optional `source` and
  `overrides`. Repo skills render a `repo` badge; a repo skill that replaces a
  global one renders `repo · overrides global`.

## Testing

Tags per root `AGENTS.md`. Unit unless marked.

### Library (Mocha, temp directories)

- Child's own skill wins over the parent's same-named skill.
- Parent-only skill is resolved through the child (`lookup`, `load`).
- Reserved name in the child directory is skipped and reported as `reserved`;
  the parent's version is served.
- Disabled child skill lets the parent's version show through.
- `name-mismatch` is skipped and reported — for a global manager and a child.
- Invalid frontmatter is skipped and reported with `detail`.
- Every write/script method on a child throws `read-only`, including for a
  parent-owned name; the filesystem is unchanged afterwards.
- `runScript` on a child throws without invoking the runner/executor.
- `list()` / `search()` set `source` on every summary and `overrides` on
  child skills that shadow the parent.
- Missing child directory yields an empty child that serves parent skills.

### API (Mocha)

- `resolveWorkspaceSkills`: workspace without `.agents/skills` → global skills
  only; workspace with `.agents/skills` and **no** `remoteUrl` → repo skill
  visible with `source: 'repo'` (no remote gate); unknown workspace →
  `NotFound`; repo `create-project` never replaces the global one.
- Expansion middleware with a fake `getSkills`: a repo skill body is
  expanded; `getSkills` is not invoked for a non-slash message; repo
  `/create-project` still expands the global body and sets
  `activeGatedSkill`.
- `makeSearchSkillsTool` returns the merged list.
- Route `[orchestration]` (supertest): 200 with `source` tags; 404 for an
  unknown workspace.

### UI (Jest)

- `ChatInput` with `workspaceId` fetches the workspace endpoint and renders
  the `repo` / `overrides global` badges; without it, fetches the global
  endpoint.

### E2E (Playwright, `@user-workflow`, CI-safe, no LLM)

Fixture: a local bare git repository containing
`.agents/skills/hello-repo/SKILL.md`. `git clone` accepts a local path, so this
exercises real provisioning and discovery without network access or mocks.

1. Create a workspace with `remoteUrl` pointing at the fixture → workspace is
   created and cloned.
2. Type `/` in the workspace chat → `/hello-repo` is listed with a `repo`
   badge.
3. Create a workspace with no remote (so no `.agents/skills/`), type `/` →
   `/hello-repo` is not listed — repo skills stay scoped to the workspace that
   ships them.
4. Cleanup: delete both workspaces (also on failure).

### Evaluations — none, deliberately

The model's inputs are unchanged in shape: an expanded human message (same as
any global skill) and the same `search_skills` output format. No prompt text
or tool description changes, so there is no LLM behavior for an eval to
verify beyond what the deterministic tests already cover.

## Out of scope

- Executing repo skill scripts (`scripts/`), or any change to the
  `trustAll` executor.
- Agent access to a repo skill's `references/`.
- `.claude/skills/` or other discovery paths.
- Per-workspace trust/opt-in flag.
- A workspace settings UI listing loaded/skipped repo skills.
- Automatic `git pull` of the clone.
- Namespaced repo commands (e.g. `/repo:deploy`).

`TODO_LIST.md` does not track this item, so no TODO update is needed.
