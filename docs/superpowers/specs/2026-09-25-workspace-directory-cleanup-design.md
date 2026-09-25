# Workspace Directory Cleanup on Delete

**Date:** 2026-09-25
**Status:** Draft
**Related:** [Issue #204](https://github.com/tkottke90/amazing-hashbrown/issues/204)

---

## Problem

`deleteWorkspaceHandler` (`api/src/routes/v1/workspaces.handlers.ts:136`) deletes the workspace's DB rows (and, for projects, the ephemeral wiki domain) but never touches `workspace.location`. The directory stays on disk, so:

- Recreating a workspace or project with the same directory slug fails. `createWorkspaceDirectory` does a deliberate non-recursive leaf `mkdir`, which throws `EEXIST`.
- Orphaned directories pile up silently, and the only fix is deleting them by hand on the host.
- The collision error ("A directory already exists at this location — choose a different name") doesn't say _which_ path is in the way.

The UI's delete confirmation (`confirm("Delete workspace …? This cannot be undone.")`) doesn't mention files on disk at all.

---

## Goals

- Deleting a workspace removes the directory the app created for it.
- Delete-then-recreate with the same name and slug succeeds.
- Before deletion the user is told exactly what happens to the files on disk, including a warning when a git-backed workspace has uncommitted changes or unpushed commits.
- If the directory is not removed (refused or failed), the user sees a warning with the path left behind, never a silent success.
- A directory-collision error on create names the path.
- Wiki behavior is unchanged: project wikis are destroyed; wikis bound manually to project-less workspaces are kept.

## Non-goals

- A unified "this workspace's directory is missing" state across the Files and Git tabs. A missing directory already degrades to per-surface `400` errors today with no crash; improving that is a separate follow-up.
- A `warning` toast variant. The existing `error` toast type is reused with a longer duration.
- Cleaning up directories orphaned before this fix. They surface through the improved `409` message and are removed by hand.
- A custom confirmation dialog component (typed-name confirmation, etc.). The native `confirm()` stays.
- Evals. No LLM-facing behavior changes.

---

## Key decisions

1. **DB rows first, filesystem best-effort after.** This matches the existing project-wiki cleanup ordering. A leftover directory can be recovered; a DB row pointing at a deleted directory is worse. A directory-removal problem never fails the delete request.
2. **Containment: `rm` only runs on a direct child of a managed root.** `locationRoot` has only existed since 1.5.0, so older workspaces may have a free-form `location` that points at a user's real repository. The recursive delete only runs if `path.dirname(path.resolve(location))` equals `path.resolve(env.projectsRoot)` or `path.resolve(env.tempProjectsRoot)`. The root itself, anything nested deeper, and anything outside are all refused.
3. **Unmanaged workspaces are still deletable.** If `location` is outside the managed roots, the workspace's DB rows (and project wiki) are deleted as normal, the directory is never touched, and the response reports it. Refusing the delete (`409`) was rejected. Containment is a check on the path string, so a legacy workspace would stay undeletable even after the user removed its directory by hand.
4. **`managedLocation` is exposed on workspace responses** so the confirmation text can be honest before the delete: it says either "will permanently delete `<path>`" or "files at `<path>` will be kept".
5. **The git warning reuses the existing `GET /workspaces/:id/git/status` endpoint** (`dirty`, `ahead`). There is no delete-specific preview endpoint.

---

## Backend

### `api/src/services/workspace-location.ts`

**`isManagedLocation(location: string, roots: string[]): boolean`**: a pure function.

- Resolves `location` and every root with `path.resolve`. `env.tempProjectsRoot` is not made absolute by `env` when it's configured, so this step is required.
- Returns `true` only when `path.dirname(resolvedLocation) === resolvedRoot` for some root.
- `isManagedWorkspaceLocation(location)` is a thin wrapper that supplies `[env.projectsRoot, env.tempProjectsRoot]`, mirroring how `resolveWorkspaceLocation` wraps `resolvePathUnderRoot`.

**`removeWorkspaceDirectory(location: string, roots: string[]): Promise<DirectoryRemovalResult>`**

```ts
export type DirectoryRemovalResult =
  | { removed: true; path: string }
  | { removed: false; path: string; reason: 'outside-managed-roots' }
  | { removed: false; path: string; reason: 'rm-failed'; error: string };
```

- If `!isManagedLocation(location, roots)`, it returns `outside-managed-roots` and never calls `rm`.
- Otherwise it calls `rm(location, { recursive: true, force: true })`:
  - `force` means an already-missing directory counts as `removed: true`.
  - `rm` uses `lstat`, so a symlinked `location` removes the link, not its target.
  - Any thrown error becomes `rm-failed` with `error: String(err)`.
- `removeManagedWorkspaceDirectory(location)` is a thin wrapper that supplies the env roots.

**`DirectoryExistsError`**: a new exported `Error` subclass carrying `path`. `createWorkspaceDirectory` throws it on leaf `EEXIST`, with the message:

> `A directory already exists at <path> — choose a different name or remove it`

### `deleteWorkspaceHandler`

The order is unchanged apart from the new last step:

1. `store.deleteWorkspace(id)` (404 if not found, as today).
2. Project-wiki destroy, best-effort (unchanged).
3. `removeManagedWorkspaceDirectory(workspace.location)`. If `removed === false`, log a warning with the workspace id, path, reason and error.
4. Return `ok({ deleted: true, directory: DirectoryRemovalResult })`.

The optional `roots` dependency is injectable the same way `registry` already is, so handler tests can point it at temp directories.

### `DELETE /api/v1/workspaces/:id`

Returns **`200`** with `{ deleted: true, directory: DirectoryRemovalResult }` instead of `204` with no body.

### `managedLocation` on workspace responses

- A single mapper, `toWorkspaceResponse(ws)`, returns `{ ...ws, managedLocation: isManagedWorkspaceLocation(ws.location) }`. It lives in the route/handler layer; the store's `Workspace` type stays DB-shaped.
- It is applied to **every** handler response that contains a workspace object: `listWorkspacesHandler`, `getWorkspaceHandler`, `createWorkspaceHandler`, `patchWorkspaceHandler`, `listProjectsHandler`, `getProjectHandler`, `createProjectHandler` (its `workspace` field), and `patchProjectHandler`. `closeProjectHandler`, `snapshotProjectHandler` and `completeCloseProjectHandler` return project or merge data only, with no workspace object, so they are unchanged.
- Coverage must be complete. If any endpoint returned a workspace without the field, the UI would overwrite `currentWorkspace` with it and the confirmation text would become wrong.

### Create handlers

`createWorkspaceHandler` and `createProjectHandler` map `DirectoryExistsError` to **`409`** (consistent with the existing duplicate-name `409`). Every other error from `resolveWorkspaceLocation`/`createWorkspaceDirectory` stays `400`.

---

## UI

### `ui/src/services/workspaces-api.ts`

- `Workspace` gains `managedLocation: boolean`, which `WorkspaceWithProject` inherits.
- New types `DirectoryRemovalResult` and `DeleteWorkspaceResult` mirror the API.
- `deleteWorkspace(id)` returns `Promise<DeleteWorkspaceResult>` and **throws on a non-OK response**. Today it ignores failures, so a 404 or 500 still navigated away and dropped the entry locally.

### `ui/src/hooks/use-workspaces.ts`

`deleteWorkspace` passes the result through. It updates the local `workspaces`/`projects` signals only after a successful response.

### Confirmation text: `buildDeleteConfirmMessage(ws, gitStatus: GitStatus | null): string`

A pure function in its own module (for example `ui/src/pages/workspaces/delete-confirm-message.ts`).

- **Managed:**
  `Delete workspace "<name>"? This permanently deletes <path> and everything in it. This cannot be undone.`
- **Managed, with local-only git work:** the managed text plus
  `⚠ This repository has uncommitted changes and N unpushed commit(s) that will be lost.`
  The line includes only the parts that apply (dirty only, ahead only, or both), and it is omitted when `gitStatus` is `null` or clean.
- **Unmanaged:**
  `Delete workspace "<name>"? Files at <path> are outside the app's managed directories and will be kept on disk.`
  There is never a git line, because nothing on disk is touched.

### `handleDelete` in `ui/src/pages/workspaces/[id].tsx`

1. If `ws.git && ws.managedLocation`, call `fetchGitStatus(ws.id)`. Any failure becomes `null`. Deletion is never blocked on the git check.
2. `if (!confirm(buildDeleteConfirmMessage(ws, gitStatus))) return;`
3. Call `deleteWorkspace(ws.id)`:
   - on a thrown error: `showToast('error', <message>)` and stay on the page.
   - on `directory.removed === false`: `showToast('error', <warning with path>, 10000)`. The text depends on the reason:
     - `rm-failed`: `Workspace deleted, but its directory could not be removed: <path>`
     - `outside-managed-roots`: `Workspace deleted. Its directory was left on disk: <path>`
4. `route('/workspaces')`.

### Create forms

No change. They already render the server's `error` string, so the new `409` message with the path shows up as is.

---

## Error handling

| Situation                                  | API                                                                 | UI                                  |
| ------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------- |
| Directory removed                          | `200`, `removed: true`                                              | Navigate to list, no toast          |
| Directory already missing                  | `200`, `removed: true` (`rm` with `force`)                          | Same as above                       |
| `location` outside managed roots           | `200`, `removed: false`, `outside-managed-roots`; warn log; no `rm` | 10-second toast with path, navigate |
| `rm` throws (EACCES, EBUSY, …)             | `200`, `removed: false`, `rm-failed`, `error`; warn log             | 10-second toast with path, navigate |
| Workspace not found                        | `404`                                                               | Error toast, stay on page           |
| Git status fetch fails before confirm      | n/a                                                                 | Confirm shown without git line      |
| Create collides with an existing directory | `409`, message names the path                                       | Existing form error display         |

---

## Testing

### API (Mocha + Chai)

`api/src/services/workspace-location.test.ts`

- `isManagedLocation` `[unit]`:
  - true for a direct child of either root
  - false for the root itself
  - false for a grandchild
  - false for a prefix-sharing sibling (`/data/projects-old/foo` against root `/data/projects`)
  - false for a `..` escape
  - relative roots resolve correctly
- `removeWorkspaceDirectory` `[unit]`, using real temp directories:
  - removes a managed directory and its contents
  - refuses an unmanaged directory, which must still exist afterwards
  - reports `removed: true` for an already-missing directory
  - removes a symlinked `location` while leaving its target intact
- `createWorkspaceDirectory` `[unit]`: throws `DirectoryExistsError` whose message and `path` contain the colliding path.

`api/src/routes/v1/workspaces.handlers.test.ts`

- delete removes the workspace directory `[orchestration]`
- delete with a `location` outside the roots keeps the directory and returns `outside-managed-roots` `[orchestration]`
- delete-then-recreate with the same slug succeeds; this is the issue's reproduction case `[orchestration]`
- project wiki is still destroyed; manually bound wiki on a project-less workspace is still kept. The existing tests are kept and extended with the `directory` assertion.
- create with a leftover directory returns `409` whose error contains the path `[unit]`
- get/list/patch responses include the correct `managedLocation` `[unit]`

`api/src/routes/v1/projects.handlers.test.ts`

- create with a leftover directory returns `409` with the path `[unit]`
- project responses include `managedLocation` `[unit]`

### UI (Jest)

- `buildDeleteConfirmMessage` `[unit]`: managed; unmanaged; managed + dirty only; managed + ahead only; managed + both; managed + `null` git status; unmanaged ignores git status.
- `deleteWorkspace` API client `[unit]`: parses the `200` body; throws on a non-OK response.

### E2E (Playwright)

- `e2e/tests/workspace/utilities.ts` and the four `toBe(204)` assertions in `e2e/tests/workspace-project.spec.ts` change to expect `200` and `directory.removed === true`.
- The existing UI delete test asserts that the confirm dialog message contains "permanently deletes".
- New `@user-workflow` step: create workspace `foo` → delete it through the UI → create `foo` again with the same slug → creation succeeds and the workspace appears in the list. The `TestSuite` definition is updated with the new step.
