# Workspace Git Provisioning & Operations — Implementation Plan

**Date:** 2026-08-31
**Spec:** [`docs/superpowers/specs/2026-08-31-workspace-git-provisioning-design.md`](../specs/2026-08-31-workspace-git-provisioning-design.md)
**Issue:** [#107](https://github.com/tkottke90/amazing-hashbrown/issues/107)

Each step below is a self-contained unit: implementation + its own tests, in dependency order. Run `npm run lint`, `npx prettier --check .`, and `npm test` after each step before moving to the next — don't let failures accumulate across steps. Steps 1–3 are spec §2 (provisioning); steps 4–7 are spec §3 (operations surface).

---

## Step 1 — `provisionGitRepository()` in `workspace-provision.ts`

Add alongside the existing `provisionDependencyIsolation()`:

```typescript
export interface GitProvisionOptions {
  git: boolean;
  remoteUrl?: string | null;
}

const GIT_CLONE_TIMEOUT_MS = 60_000;
const GIT_INIT_TIMEOUT_MS = 10_000;

export async function provisionGitRepository(
  location: string,
  opts: GitProvisionOptions,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void>;
```

- `git: false` → no-op, no shell-out (mirrors `provisionDependencyIsolation`'s "neither flag set" no-op).
- `git: true`, `remoteUrl` set (after `.trim()`) → `execFileFn('git', ['clone', '--', remoteUrl, '.'], { cwd: location, timeout: GIT_CLONE_TIMEOUT_MS })`.
- `git: true`, no `remoteUrl` → `execFileFn('git', ['init'], { cwd: location, timeout: GIT_INIT_TIMEOUT_MS })`.
- Let a rejection from `execFileFn` propagate uncaught (matches `provisionDependencyIsolation`'s existing behavior — the caller handles rollback).

**Tests** (extend `workspace-provision.test.ts`, new `describe('provisionGitRepository()', ...)` block, same `makeStub` helper already in the file):
- No-op / no shell-out when `git: false`.
- `git init` invoked with the exact argv/opts when `git: true` and no `remoteUrl`.
- `git clone -- <url> .` invoked with the exact argv/opts when `remoteUrl` is set; a `remoteUrl` with leading/trailing whitespace is trimmed first.
- Rejection from `execFileFn` propagates (same "propagates a rejection" pattern as the existing dependency-isolation test).

Run `npm test --workspace api -- --grep workspace-provision` (or the closest equivalent Mocha filter) to confirm before moving on.

---

## Step 2 — Wire into `createWorkspaceHandler` / `createProjectHandler`

In `api/src/routes/v1/workspaces.handlers.ts` and `api/src/routes/v1/projects.handlers.ts`:

- Import `provisionGitRepository` alongside the existing `provisionDependencyIsolation` import.
- Call it **immediately after** `createWorkspaceDirectory(location)` and **before** `provisionDependencyIsolation(...)` — the clone/init step needs an empty directory.
- On failure: same rollback as the existing dependency-isolation failure branch — `await rm(location, { recursive: true, force: true })`, return `badRequest(...)` with the underlying error message. (`rm` is already imported in both files.)
- Pass `{ git: !!body.git, remoteUrl: body.remoteUrl as string | undefined }` — `body.remoteUrl` is untyped `Record<string, unknown>` input at this point, same as every other field pulled off `body` in these handlers today.

**Tests** (extend `workspaces.handlers.test.ts` and `projects.handlers.test.ts`, following the existing stubbed-`execFileFn` pattern already used for dependency-isolation assertions in these files):
- `git: true` + `remoteUrl` → the stub receives a `git clone` call before the `npm`/`python3` calls (order matters — assert call order, not just call presence).
- `git: true`, no `remoteUrl` → stub receives `git init` before dependency-isolation calls.
- `git: false` → no git call at all, dependency isolation still runs as before (regression check — this must not break the existing dependency-isolation tests).
- Git provisioning failure → directory is removed (same assertion style as the existing "dependency isolation failure rolls back" test) and the handler returns `400`.

---

## Step 3 — Agent tool parity: `remoteUrl` on `create_workspace` / `create_project`

In `api/src/agents/tools/create-workspace.tool.ts` and `create-project.tool.ts`:

- Add `remoteUrl: z.string().optional().describe('Git remote URL to clone, if any. Requires git to be enabled.')` to `CreateWorkspaceSchema` / `CreateProjectSchema`.
- Destructure `remoteUrl` in the tool's async handler and pass it through in the `createWorkspaceHandler`/`createProjectHandler` call body alongside `git`.

**Tests** (extend `create-workspace.tool.test.ts`, `create-project.tool.test.ts`):
- Calling the tool with `git: true, remoteUrl: '...'` results in the store/handler receiving that `remoteUrl` (assert via the injected test store/registry, same pattern the existing `git: true` assertion in `create-workspace.tool.test.ts:56` uses).
- Omitting `remoteUrl` leaves existing behavior unchanged (`git: true` alone still works — this is a non-regression check).

**Checkpoint:** spec §2 (provisioning) is now complete and independently testable end-to-end — a workspace/project created through any path (UI, agent tool, direct API call) with `git: true` gets a real `.git`. Good point to run the full `npm test` and confirm the Files tab (`getFileTree` → `getGitOverlay`) no longer throws for a freshly created git workspace before continuing to the operations surface.

---

## Step 4 — `workspace-git.ts` service

New file `api/src/services/workspace-git.ts`. Follow the `execFileFn`-injectable pattern from `workspace-files.ts`/`workspace-provision.ts` exactly (default `execFileAsync = promisify(execFile)`, `ExecFileFn` type imported from `workspace-provision.ts`).

Functions, per spec §3.1:

- `getGitStatus(location, execFileFn?)` → run `git status --porcelain=2 --branch` (a single call gives branch, upstream, ahead/behind, and dirty-file presence in one shot — cheaper than three separate calls). Parse the `# branch.head`, `# branch.upstream`, `# branch.ab +N -M` header lines plus whether any non-header line exists (→ `dirty: true`). Return `{ branch, upstream, ahead, behind, hasRemote: upstream !== null, dirty }`. Handle "no upstream configured" (no `# branch.upstream` line) as `upstream: null, ahead: 0, behind: 0`.
- `listBranches(location, execFileFn?)` → `git branch -a --format='%(refname:short)'`, then split into `local` (no `/` prefix matching a known remote) vs `remote` (`<remote>/<branch>` entries, excluding `<remote>/HEAD`). Simplest reliable split: anything not starting with a configured remote name is local — but since we don't want to shell out twice, parse `git branch -a` in its default `  branchname` / `* branchname` / `  remotes/origin/branchname` output form is fragile; prefer `git for-each-ref --format='%(refname)' refs/heads refs/remotes` and split on the `refs/heads/` vs `refs/remotes/` prefix, stripping it. Confirm exact parsing against a real repo while writing the test fixtures in this step, not by inference alone.
- `fetchRemote(location, execFileFn?)` → `git fetch`.
- `syncFastForward(location, execFileFn?)` → `git fetch` then `git merge --ff-only @{u}`; let a merge failure's error (git's own stderr) propagate — do not catch/rewrite it.
- `pushBranch(location, execFileFn?)` → first check current upstream (reuse the upstream-detection logic from `getGitStatus`, or a lighter-weight `git rev-parse --abbrev-ref --symbolic-full-name @{u}` that fails-non-zero when unset); if unset, run `git push -u origin <currentBranch>` (get the branch name via `git branch --show-current`, same call `getGitOverlay` already makes); if set, run plain `git push`.
- `checkoutBranch(location, branch, execFileFn?)` → `execFileFn('git', ['checkout', '--', branch], ...)`.
- `createBranch(location, name, from, execFileFn?)` → `execFileFn('git', ['checkout', '-b', '--', name, ...(from ? [from] : [])], ...)` — confirm `git checkout -b` accepts `--` in this position while writing the test (some git subcommands place `--` differently); if `-b` doesn't compose cleanly with a trailing `--`, fall back to validating `name`/`from` don't start with `-` before invoking, and document why in a code comment.

**Concurrency lock**: a module-level `const locked = new Set<string>()`. A small wrapper `withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>` that throws a distinguishable error (e.g. `class GitOperationInProgressError extends Error`) if `workspaceId` is already in the set, otherwise adds it, runs `fn()` in a `try/finally` that deletes it. Applied only around `fetchRemote`, `syncFastForward`, `pushBranch`, `checkoutBranch`, `createBranch` at the handler layer (Step 5) — keep the lock in the service module but let the *handlers* decide which calls acquire it, since `getGitStatus`/`listBranches` must stay lock-free even while a mutation is running (so the UI can still show "sync in progress" state).

**Tests**, new `api/src/services/workspace-git.test.ts`, same `makeStub`-style helper as `workspace-provision.test.ts`:
- `getGitStatus` parsing: clean repo with upstream ahead/behind, repo with no upstream, dirty repo (uncommitted changes present).
- `listBranches` parsing against representative `for-each-ref` output (local branches, remote branches, no `HEAD` entry leaking through).
- `fetchRemote`, `syncFastForward` (success and ff-only-failure-propagates-message cases), `checkoutBranch`, `createBranch`: exact argv assertions, including the `--` guard.
- `pushBranch`: asserts `git push -u origin <branch>` when no upstream, plain `git push` when one exists — stub the upstream-check call to return each case.
- `withLock`: two overlapping calls on the same workspace id — second rejects with `GitOperationInProgressError` while the first is pending (use a controllable/delayed stub); lock releases after success and after a rejected `fn()` (both paths tested), allowing a subsequent call through.

---

## Step 5 — `workspace-git.handlers.ts` + `workspace-git.route.ts`

New `api/src/routes/v1/workspace-git.handlers.ts`, following `workspace-files.handlers.ts`'s shape (its own local `ok`/`notFound`/`badRequest`/`conflict`/`serverError` helpers — same duplication convention already used per-file in this codebase, don't try to share them across files).

Handler set (spec §3.2 table): `getGitStatusHandler`, `listBranchesHandler`, `fetchHandler`, `syncHandler`, `pushHandler`, `checkoutHandler` (body `{ branch }`), `createBranchHandler` (body `{ name, from? }`).

Shared guard logic at the top of every handler:
1. `const workspace = store.getWorkspace(workspaceId); if (!workspace) return notFound(...)`.
2. `if (!workspace.git) return badRequest('Workspace does not have git enabled')`.

Mutating handlers (`fetch`, `sync`, `push`, `checkout`, `createBranch`):
3. Wrap the service call in `withLock`; catch `GitOperationInProgressError` specifically and return `conflict('A git operation is already running for this workspace')` (409).
4. On success, call `invalidateFileTreeCache(workspaceId)` (import from `workspace-files.ts`, already exported) before returning `ok(...)`.
5. On any other thrown error, return `badRequest(err.message)` — matches how git-command failures are surfaced elsewhere in this codebase (e.g. `getFileTreeHandler`'s catch block).

New `api/src/routes/v1/workspace-git.route.ts`, mirroring `workspace-files.route.ts` (`Router({ mergeParams: true })`, one route per handler, `req.params['id']`).

Mount in `api/src/routes/v1/workspaces.route.ts`:
```typescript
workspacesRouter.use('/:id/git', workspaceGitRouter);
```

**Tests**, new `api/src/routes/v1/workspace-git.handlers.test.ts`, following `workspace-files.handlers.test.ts`'s temp-dir-backed `WorkspaceStore` + stubbed-`execFileFn` pattern:
- 404 for an unknown workspace id, once per handler (a small loop/table-driven test is fine here rather than seven near-identical `it` blocks).
- 400 for a workspace with `git: false`, once per handler.
- Success path per handler, including the `invalidateFileTreeCache` effect (assert via a subsequent `getFileTree` call returning fresh, not cached, data — same technique the existing file-tree cache test already uses).
- A git-command failure surfaces as `400` with the underlying message.
- Concurrency: start a mutating call with a stub that doesn't resolve immediately (a manually-controlled promise), fire a second mutating call on the same workspace while the first is pending, assert `409`; then resolve the first and confirm a third call succeeds.

---

## Step 6 — UI API client

New `ui/src/services/workspace-git-api.ts`, following the `request<T>()` pattern already duplicated in `workspace-files-api.ts`/`workspaces-api.ts` (don't try to extract a shared helper across files — matches the existing convention).

```typescript
export interface GitStatus { branch: string | null; upstream: string | null; ahead: number; behind: number; hasRemote: boolean; dirty: boolean }
export interface GitBranches { local: string[]; remote: string[] }

export function fetchGitStatus(workspaceId: string): Promise<GitStatus>;
export function fetchGitBranches(workspaceId: string): Promise<GitBranches>;
export function gitFetch(workspaceId: string): Promise<GitStatus>;
export function gitSync(workspaceId: string): Promise<GitStatus>;
export function gitPush(workspaceId: string): Promise<GitStatus>;
export function gitCheckout(workspaceId: string, branch: string): Promise<GitStatus>;
export function gitCreateBranch(workspaceId: string, name: string, from?: string): Promise<GitStatus>;
```

No tests needed for this file alone (thin wrappers, matching that `workspace-files-api.ts` itself has no dedicated unit test today — it's exercised indirectly through the hook/component tests).

---

## Step 7 — `GitControls` component + `FilesTab` integration

New `ui/src/pages/workspaces/git-controls.tsx`. Signal-based state local to the component (`useSignal`), following `workspace-settings-drawer.tsx`'s in-flight/error pattern (`saving`/`error` signals, disable-while-in-flight, inline error text).

- On mount, `fetchGitStatus` + `fetchGitBranches`.
- Renders: current branch name, an ahead/behind badge (only when `hasRemote`), a branch `<select>` (or the existing dropdown component this codebase uses elsewhere — check `ui/src/components/ui/` for an existing `Select` before introducing a new pattern) populated from `local`/`remote`, plus a "+ new branch" input toggle backed by `gitCreateBranch`, and Sync / Push buttons.
- Every button/select action: set an in-flight signal, call the API, on success re-fetch status (or use the `GitStatus` the mutating call itself returns, per the client signatures above, to avoid a redundant round trip) and call `loadFileTree(workspaceId, { force: true })` (import from `use-workspace-files.ts`) so the Files tab's branch/status badges refresh; on failure, set the error signal and surface it inline.

In `ui/src/pages/workspaces/files-tab.tsx`: render `<GitControls workspaceId={workspaceId} />` conditionally — needs the workspace's `git` flag, which `FilesTab` doesn't currently receive as a prop (it only takes `workspaceId`). Check how `FilesTab` is invoked from its parent (`[id].tsx`) and either pass `git: boolean` down as a new prop, or have `GitControls` itself receive that flag from the caller — confirm the simplest wiring against the actual call site before choosing.

**Tests**, new `ui/test/git-controls.test.tsx`, following `workspace-create-form.test.tsx`'s Preact Testing Library + mocked-API-module conventions:
- Not rendered when `git` is `false`.
- Status/branch data from a mocked `fetchGitStatus`/`fetchGitBranches` renders correctly (branch name, ahead/behind badge only when `hasRemote`).
- Clicking Sync/Push calls the corresponding mocked API function, disables the button while its promise is pending, and shows the returned error message on rejection.
- Selecting a different branch calls `gitCheckout` with that branch name.
- The "new branch" flow calls `gitCreateBranch` with the entered name.

---

## Step 8 — Final pass

- `npm run lint`, `npx prettier --check .`, `npm test` (full suite) from repo root.
- Manual smoke check via the `run` skill: create a workspace with `git: true` and a real (small, public) `remoteUrl` through the UI form, confirm the Files tab shows the branch immediately with no error, click Sync (should no-op cleanly, already up to date), and confirm the branch dropdown lists at least the current branch.
- Update `TODO_LIST.md` per `AGENTS.md`'s convention if this work maps to an existing outstanding item there — check first; if it isn't already listed, no entry is needed (this plan originates from issue #107, not the TODO list).

---

## Explicitly not touched by this plan

Everything already listed in the spec's §5/§6 (existing broken rows, settings-drawer `remoteUrl` edits staying metadata-only, no new agent tools for git ops, no auto-stash/force recovery, no non-GitHub backend provisioning, the `pushBranch` `origin`-hardcoding limitation). This plan implements the spec as approved — it does not re-litigate those boundaries.
