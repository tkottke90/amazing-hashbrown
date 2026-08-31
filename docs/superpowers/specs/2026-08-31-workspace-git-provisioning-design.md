# Workspace Git Provisioning & Operations — Design

**Date:** 2026-08-31
**Status:** Approved
**Issue:** [#107 — Bug: Git repository not properly attached to workspace — workspace directory lacks .git folder and git commands fail](https://github.com/tkottke90/amazing-hashbrown/issues/107)

---

## 1. Problem & Root Cause

Workspaces and projects carry a `git: boolean` flag and a `remoteUrl: string | null` field (`api/src/services/workspace-store.ts`), and the manual creation UI (`ui/src/pages/workspaces/index.tsx`) already requires a remote URL whenever "Git" is toggled on. But nothing on the backend ever acts on either field: `createWorkspaceHandler` / `createProjectHandler` (`api/src/routes/v1/workspaces.handlers.ts`, `projects.handlers.ts`) create the plain directory and provision npm/venv isolation (`provisionDependencyIsolation`), then persist `git`/`remoteUrl` as inert DB columns. No `git init` or `git clone` is ever run.

Downstream code already assumes a real repository exists once `workspace.git` is `true`:

- `getFileTree()` (`api/src/services/workspace-files.ts:183`) shells out `git branch --show-current` / `git status --porcelain` whenever `workspace.git` is true, with no error handling — this throws and breaks the Files tab entirely for any git-enabled workspace with no real `.git`.
- `snapshotProjectWiki()` (`api/src/services/wiki-snapshot.ts`) runs `git add` / `git commit` on project close when `workspace.git` is true, and will fail the same way.

This is exactly what issue #107 reports from the agent's perspective (`git branch --show-current` returning "fatal: not a git repository" via `shell_exec`), and it reproduces identically through the UI's own Files tab.

Separately, the agent-facing `create_workspace` / `create_project` tools (`api/src/agents/tools/*.tool.ts`) expose only `git: boolean` — no `remoteUrl` — so an agent-driven creation can never request a specific repo, unlike the manual UI form.

Once workspaces are correctly provisioned, there is still no way to keep them in sync with their remote short of the agent shelling out ad hoc: no fetch/pull/push/branch-switch surface exists anywhere in the app today.

---

## 2. Fix, Part 1: Provision the repo at creation time

Add `provisionGitRepository()` to `api/src/services/workspace-provision.ts`, a sibling to the existing `provisionDependencyIsolation()`, using the same injectable-`execFileFn` pattern:

```typescript
export interface GitProvisionOptions {
  git: boolean;
  remoteUrl?: string | null;
}

export async function provisionGitRepository(
  location: string,
  opts: GitProvisionOptions,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void>;
```

- `git: false` → no-op.
- `git: true` + `remoteUrl` set → `git clone -- <remoteUrl> .` run with `cwd: location`. The `--` blocks a malformed/malicious `remoteUrl` from being parsed as a flag.
- `git: true` + no `remoteUrl` → `git init`.
- A generous timeout (clone can be slow for large repos) distinct from the existing 30s `PROVISION_TIMEOUT_MS` used for `npm init`/`venv`.

**Wiring:** called from `createWorkspaceHandler` and `createProjectHandler`, positioned **before** `provisionDependencyIsolation` — `git clone` requires an empty target directory, and `npm init -y` would populate it first otherwise. On failure, same rollback as the existing dependency-isolation failure path: `rm -rf` the created directory, return `400` with the underlying git error message (bad URL, auth failure, network error, etc.).

No new credential handling is introduced — issue #107 itself confirms `gh`/git auth is already configured in the environment the API runs in (`gh repo view` already works), so a plain `git clone` rides on that ambient configuration.

**Agent tool parity:** add an optional `remoteUrl: z.string().optional()` to `CreateWorkspaceSchema` and `CreateProjectSchema` (`create-workspace.tool.ts`, `create-project.tool.ts`), threaded straight through to the handler body, so agent-driven creation can request a clone the same way the UI form does.

**Explicitly out of scope:** existing rows that already have `git: true` with no real `.git` folder are not repaired by this change. Editing `remoteUrl` on an already-created workspace via the settings drawer (`workspace-settings-drawer.tsx`) stays metadata-only — no filesystem action.

---

## 3. Fix, Part 2: Git operations HTTP surface

A git-enabled workspace needs to stay in sync after creation: fetch, fast-forward pull, push, and branch switching. The agent already has unrestricted shell access and can run any git command directly against `workspace.location` — so this surface is for the **UI only**; no new agent tools are added here.

### 3.1 Service: `api/src/services/workspace-git.ts` (new)

Mirrors the `execFileFn`-injectable pattern already used by `workspace-files.ts` / `workspace-provision.ts` / `wiki-snapshot.ts`.

| Function | Behavior |
| --- | --- |
| `getGitStatus(location)` | Returns `{ branch, upstream: string \| null, ahead: number, behind: number, hasRemote: boolean, dirty: boolean }`. A read-only, lightweight call — separate from the existing `getGitOverlay()`, which stays untouched and keeps serving the file tree's per-file M/A badges. |
| `listBranches(location)` | Returns `{ local: string[], remote: string[] }` for the branch-switcher dropdown. |
| `fetchRemote(location)` | `git fetch`. |
| `syncFastForward(location)` | `git fetch` + `git merge --ff-only @{u}`. Surfaces git's own error message on conflict/diverged history rather than stashing or forcing anything. |
| `pushBranch(location)` | `git push`, or `git push -u origin <branch>` the first time the current branch has no upstream. |
| `checkoutBranch(location, branch)` | `git checkout <branch>` for an existing local or remote-tracking branch. |
| `createBranch(location, name, from?)` | `git checkout -b <name> [<from>]`, then the branch is current. |

Every ref/branch/name argument that originates from a request body is passed to `execFile` after a `--` separator, the same flag-injection guard used for `remoteUrl` in Part 1.

**Concurrency:** an in-memory `Set<workspaceId>` lock guards the mutating operations (`fetchRemote`, `syncFastForward`, `pushBranch`, `checkoutBranch`, `createBranch`) — acquired before the shell-out, released in `finally`. An overlapping call while one is in flight returns `409` rather than racing on git's own `index.lock`. Read-only calls (`getGitStatus`, `listBranches`) don't take the lock.

### 3.2 Handlers + route

New `api/src/routes/v1/workspace-git.handlers.ts` (same `ok`/`notFound`/`badRequest`/`conflict`/`serverError` helper shape already duplicated per-file across this codebase) and `workspace-git.route.ts`, mounted the same way `workspaceFilesRouter` is:

```typescript
workspacesRouter.use('/:id/git', workspaceGitRouter);
```

| Method & path | Body | Behavior |
| --- | --- | --- |
| `GET /v1/workspaces/:id/git/status` | — | `getGitStatus` |
| `GET /v1/workspaces/:id/git/branches` | — | `listBranches` |
| `POST /v1/workspaces/:id/git/fetch` | — | `fetchRemote` |
| `POST /v1/workspaces/:id/git/sync` | — | `syncFastForward` |
| `POST /v1/workspaces/:id/git/push` | — | `pushBranch` |
| `POST /v1/workspaces/:id/git/checkout` | `{ branch: string }` | `checkoutBranch` |
| `POST /v1/workspaces/:id/git/branches` | `{ name: string, from?: string }` | `createBranch` |

Every handler 404s if the workspace doesn't exist and 400s up front if `workspace.git` is not `true`. Every mutating handler calls `invalidateFileTreeCache(workspaceId)` (already exported from `workspace-files.ts`) on success, so the Files tab's branch/status picks up the change on its next load. The concurrency lock surfaces as `409` from the handler layer.

No server-side confirmation gate is added on push — it's invoked only by an explicit UI button click, which is itself the deliberate action; this mirrors how the rest of the app treats a button click as consent (e.g. "Delete", "Close project").

### 3.3 UI

- New client `ui/src/services/workspace-git-api.ts` — thin wrappers over the endpoints above, following the existing `request<T>()` pattern in `workspace-files-api.ts` / `workspaces-api.ts`.
- New component `ui/src/pages/workspaces/git-controls.tsx`, rendered inside `FilesTab` (`files-tab.tsx`) near the existing branch display: current branch name, an ahead/behind badge, a branch dropdown (existing local + remote branches, plus a "new branch…" affordance backed by `createBranch`), and Sync / Push buttons.
- Rendered only when `ws.git` is `true` — same gating already used for the `git-chip` in `[id].tsx`.
- Buttons disable while their request is in flight; errors render inline, following the existing inline-error convention (`workspace-settings-drawer.tsx`, the create-workspace form).
- On any successful mutating action, re-run `loadFileTree(workspaceId, { force: true })` (already exported from `use-workspace-files.ts`) so the branch name and file-status badges refresh immediately.

### 3.4 Note on non-GitHub git backends (e.g. Radicle)

Nothing in this design is GitHub-specific: every operation shells out to plain `git` against whatever remote is already configured, so a repository backed by a different transport should work without code changes, *provided that transport's git-remote-helper is installed and reachable in the environment*. [Radicle](https://radicle.dev/), for example, ships a `git-remote-rad` helper — once installed, a `rad://<repo-id>` URL is just another value for `remoteUrl`, and `git clone -- <remoteUrl> .` (§2) resolves it exactly like an `https://` or `git@` URL.

One known gap: `pushBranch`'s no-upstream-yet fallback (§3.1) is hardcoded to `git push -u origin <branch>`. GitHub clones conventionally name their remote `origin`, but a Radicle-cloned repo's remote is conventionally named `rad` — so the very first push of a newly created branch on such a workspace would target a remote that doesn't exist. Fixing this (detect the configured remote name instead of assuming `origin`, e.g. from `git remote`) is straightforward but out of scope for this pass; it's called out here as a known limitation rather than fixed speculatively, since GitHub is the only backend in active use today.

Also out of scope, and unlike GitHub: Radicle's auth model is a running `radicle-node` process with a locally provisioned identity (`rad auth`), not a static credential file. This design's "no credential handling — rides on the environment's ambient git auth" stance (§2) assumes that auth is already sitting there when a git command runs; Radicle would need that *process* running and reachable, which is a heavier environmental prerequisite this design doesn't provision or verify.

---

## 4. Testing

### Unit — `api/src/services/workspace-provision.test.ts` (extend or add)
- `provisionGitRepository`: no-op when `git: false`; `git init` invoked when `git: true` with no `remoteUrl`; `git clone -- <url> .` invoked when `remoteUrl` is set; failure propagates (for the handler-level rollback test to catch).

### Unit — `api/src/services/workspace-git.test.ts` (new)
- `getGitStatus`: parses branch/upstream/ahead/behind/dirty from stubbed `execFileFn` output, including the no-upstream-configured case (`hasRemote: false`).
- `listBranches`: parses local vs. remote-tracking branch names from stubbed output.
- `fetchRemote` / `syncFastForward` / `pushBranch` / `checkoutBranch` / `createBranch`: correct argv (including the `--` guard) passed to `execFileFn`; `pushBranch` uses `-u origin <branch>` only when no upstream is configured; `syncFastForward` surfaces the underlying git error message unchanged on failure.
- Concurrency lock: two overlapping mutating calls on the same workspace location — the second is rejected while the first is in flight, and the lock is released after completion (success or failure) so a subsequent call succeeds.

### Handler tests — `api/src/routes/v1/workspace-git.handlers.test.ts` (new)
Follows `workspace-files.handlers.test.ts`'s pattern (temp-dir-backed `WorkspaceStore`, stubbed `execFileFn`):
- 404 for an unknown workspace id, on every endpoint.
- 400 for a workspace with `git: false`, on every endpoint.
- Success path per endpoint, asserting `invalidateFileTreeCache` was triggered (observable via a subsequent `getFileTree` call not returning stale cached data, matching the existing cache test pattern in `workspace-files.test.ts`).
- Git-command failure (e.g. `syncFastForward` hitting a non-fast-forwardable state) passes the underlying error message through as the handler's error string.
- Concurrency: a second request while a mutating one is in flight gets `409`.

### Agent tool tests — extend `create-workspace.tool.test.ts` / `create-project.tool.test.ts`
- `remoteUrl` passed through to the handler body when provided; omitted (`undefined`) leaves existing `git: true`-only ("plain init") behavior unchanged.

### UI — `ui/test/git-controls.test.tsx` (new)
Following `workspace-create-form.test.tsx`'s Preact Testing Library conventions:
- Not rendered when `workspace.git` is `false`.
- Branch/ahead-behind display reflects the fetched status.
- Sync/Push/Checkout/Create-branch buttons call the corresponding API function, disable while in flight, and render the returned error message on failure.

---

## 5. Files Changed

| File | Change |
| --- | --- |
| `api/src/services/workspace-provision.ts` | Adds `provisionGitRepository()` and `GitProvisionOptions` |
| `api/src/routes/v1/workspaces.handlers.ts` | `createWorkspaceHandler` calls `provisionGitRepository()` before `provisionDependencyIsolation`, with rollback on failure |
| `api/src/routes/v1/projects.handlers.ts` | `createProjectHandler` — same wiring as above |
| `api/src/agents/tools/create-workspace.tool.ts` | `CreateWorkspaceSchema` gains optional `remoteUrl`, threaded through to the handler |
| `api/src/agents/tools/create-project.tool.ts` | `CreateProjectSchema` gains optional `remoteUrl`, threaded through to the handler |
| `api/src/services/workspace-git.ts` (new) | Status/branches/fetch/sync/push/checkout/create-branch operations, with the per-workspace concurrency lock |
| `api/src/routes/v1/workspace-git.handlers.ts` (new) | HTTP handlers wrapping the service, per §3.2 |
| `api/src/routes/v1/workspace-git.route.ts` (new) | Router, mounted at `/:id/git` |
| `api/src/routes/v1/workspaces.route.ts` | Mounts `workspaceGitRouter` |
| `ui/src/services/workspace-git-api.ts` (new) | Client wrappers for the new endpoints |
| `ui/src/pages/workspaces/git-controls.tsx` (new) | Branch display, ahead/behind badge, branch switcher, Sync/Push buttons |
| `ui/src/pages/workspaces/files-tab.tsx` | Renders `GitControls` when `workspace.git` is true |
| `api/src/services/workspace-provision.test.ts` | Coverage per §4 |
| `api/src/services/workspace-git.test.ts` (new) | Coverage per §4 |
| `api/src/routes/v1/workspace-git.handlers.test.ts` (new) | Coverage per §4 |
| `api/src/agents/tools/create-workspace.tool.test.ts` | Coverage for the new `remoteUrl` param |
| `api/src/agents/tools/create-project.tool.test.ts` | Coverage for the new `remoteUrl` param |
| `ui/test/git-controls.test.tsx` (new) | Coverage per §4 |

---

## 6. Out of Scope

- Repairing existing workspace/project rows that already have `git: true` with no real `.git` directory.
- Any filesystem action from editing `remoteUrl` on an already-created workspace via the settings drawer.
- New agent tools for git operations — the agent already has shell access and can run git directly against the workspace directory.
- Auto-stashing, force-checkout, or any other data-discarding recovery path for a dirty working tree — conflicts and blocked operations are surfaced as errors, not auto-resolved.
- Credential management for private remotes — relies entirely on the host environment's already-configured git/`gh` authentication.
- Merge/rebase (beyond the fast-forward-only sync), cherry-pick, tag management, or any other git operation not explicitly listed in §3.1.
- Installing, configuring, or provisioning any non-GitHub git backend (e.g. Radicle's `git-remote-rad` helper or a running `radicle-node`) in the Docker image or elsewhere — see §3.4 for what would and wouldn't already work if one were present.
- Fixing `pushBranch`'s hardcoded `origin` fallback to detect the actual configured remote name — documented as a known limitation in §3.4, not fixed in this pass.
