# Workspace Creation — Dependency Isolation — Design

**Date:** 2026-08-25
**Status:** Draft
**Related:** [Issue #70](https://github.com/tkottke90/amazing-hashbrown/issues/70)

---

## Goal

Let a user declare, at workspace/project creation time, whether the agent sandbox needs JavaScript and/or Python dependency isolation — actually scaffold that isolation on disk (`package.json` / a venv), store the choice, and show it on the workspace detail page. Once created, the choice is permanent.

---

## Problem

Workspaces can be JavaScript codebases, Python codebases, or both, and the agent sandbox needs to know which runtimes to isolate to avoid cross-contaminating dependencies. The `workspaces` table already has `javascript`/`python` columns (migration 18, `WorkspaceStore`), and the backend already accepts and returns both fields on `POST/PATCH /api/v1/workspaces` and `POST/PATCH /api/v1/projects` (`createWorkspaceHandler`/`createProjectHandler` pass `body` straight through to the store). But:

- The creation form (`ui/src/pages/workspaces/index.tsx`) never surfaces these fields, so every workspace is created with `javascript: false, python: false` regardless of intent.
- Nothing on disk actually reflects the choice — no `package.json`, no virtualenv — so the flags are inert metadata today.
- The workspace detail page (`ui/src/pages/workspaces/[id].tsx`) never shows which modes are active.

The settings drawer (`ui/src/components/workspace-settings-drawer.tsx`) already renders `javascript`/`python` as read-only text (lines 126–133) with no edit path — that part of the issue is already done and needs no changes.

---

## Non-goals

- Any change to `WorkspaceStore`, the `workspaces` table, or the `NewWorkspaceInput`/`PatchWorkspaceInput` types — the columns and plumbing already exist end-to-end.
- Changes to `WorkspaceSettingsDrawer` — it already displays `javascript`/`python` read-only and never lets them be edited.
- Blocking `javascript`/`python` in `patchWorkspaceHandler`/`patchProjectHandler` at the API layer. Unlike `wikiId` (which is blocked server-side because a project's wiki domain is a real downstream dependency), there's no data-integrity invariant tied to these flags post-creation — "read-only after creation" is enforced by the UI never sending them on `PATCH`, matching how every other non-`wikiId` field on the settings drawer already works.
- Re-provisioning, repairing, or migrating an existing workspace's isolation setup. This only runs once, at creation.
- A configurable path to the `npm`/`python3` binaries. This follows the existing precedent in `wiki-upload.route.ts`, which assumes `unzip`/`tar` are simply on `PATH`.
- Windows host support (`python3` vs. `python`) — this app's existing self-hosted/homelab context assumes a Linux/macOS host, same assumption the rest of the codebase makes.

---

## Design

### 1. Backend: provisioning service (`api/src/services/workspace-provision.ts`, new)

```ts
export interface DependencyIsolationOptions {
  javascript: boolean;
  python: boolean;
}

export async function provisionDependencyIsolation(
  location: string,
  opts: DependencyIsolationOptions,
  execFileFn: typeof execFileAsync = execFileAsync,
): Promise<void> {
  if (opts.javascript) {
    await execFileFn('npm', ['init', '-y'], { cwd: location });
  }
  if (opts.python) {
    await execFileFn('python3', ['-m', 'venv', '.venv'], { cwd: location });
  }
}
```

- Uses `promisify(execFile)`, the same pattern already used for `unzip`/`tar` in `wiki-upload.route.ts`.
- Runs JavaScript then Python serially (not in parallel) so a failure is unambiguous about which one failed.
- Neither command runs if its flag is `false` — a workspace with both unchecked touches the filesystem exactly as it does today (just the `mkdir` from `createWorkspaceDirectory`).
- `execFileFn` is an injectable parameter (default: the real `execFileAsync`) purely so handler/service tests can stub it instead of depending on `npm`/`python3` actually being installed in CI — mirrors the optional `registry` parameter already used in `createProjectHandler` for the same testability reason.
- Errors (a non-zero exit, or `ENOENT` when the binary isn't on `PATH`) propagate to the caller unmodified; this function makes no decision about rollback.

### 2. Handler wiring

Both `createWorkspaceHandler` (`workspaces.handlers.ts`) and `createProjectHandler` (`projects.handlers.ts`) call this immediately after `createWorkspaceDirectory(location)` succeeds and before any other side effect (wiki domain creation, DB insert):

```ts
try {
  await provisionDependencyIsolation(location, {
    javascript: !!body.javascript,
    python: !!body.python,
  });
} catch (err) {
  await rm(location, { recursive: true, force: true });
  return badRequest(
    `Failed to provision dependency isolation: ${err instanceof Error ? err.message : String(err)}`,
  );
}
```

Placing this first — before the wiki domain provisioning in `createProjectHandler` — keeps rollback to "delete the directory just created." It mirrors the existing all-or-nothing pattern already used for the wiki domain (create → on failure, destroy what was made → return an error), just one step earlier in the sequence. `rm` comes from `node:fs/promises`, alongside the `mkdir` already imported in `workspace-location.ts`.

Neither handler needs new validation on `body.javascript`/`body.python` beyond the existing `!!` coercion already used when the store maps them to `0`/`1` — a missing or non-boolean value simply behaves as `false`.

### 3. Frontend — creation form (`ui/src/pages/workspaces/index.tsx`)

`CreateWorkspaceForm` gains two new signals:

```ts
const javascriptEnabled = useSignal(false);
const pythonEnabled = useSignal(false);
```

A new bordered section, rendered for both Workspace and Project modes, placed after the Git repository block and before the Project-mode-only fields:

```tsx
<div class="border border-border rounded-lg p-3 flex flex-col gap-3">
  <p class="text-sm font-medium">Dependency isolation</p>
  <label class="flex items-center gap-2 text-sm">
    <Checkbox
      checked={javascriptEnabled.value}
      onCheckedChange={(checked) => {
        javascriptEnabled.value = checked === true;
      }}
    />
    JavaScript <span class="text-muted-foreground">(node_modules)</span>
  </label>
  <label class="flex items-center gap-2 text-sm">
    <Checkbox
      checked={pythonEnabled.value}
      onCheckedChange={(checked) => {
        pythonEnabled.value = checked === true;
      }}
    />
    Python <span class="text-muted-foreground">(venv)</span>
  </label>
</div>
```

`Checkbox` is imported from `@/components/ui/checkbox` — an existing component (radix-ui, aliased to `preact/compat` via `vite.config.ts`) that is not yet used anywhere in the codebase but matches the mockup's checked/unchecked square styling exactly. Both checkboxes default unchecked and toggle independently.

**Submit payload:** both `createWorkspace(...)` and `createProject(...)` calls add:

```ts
javascript: javascriptEnabled.value,
python: pythonEnabled.value,
```

No new validation is needed — unlike Git, there's no dependent required field when a box is checked.

### 4. Frontend — detail page (`ui/src/pages/workspaces/[id].tsx`)

The existing metadata chip row (which already renders Git/Wiki chips conditionally) gains two more, styled to match the mockup's "Dependency isolation" chip (a small checked-square glyph + label + muted hint), shown only when active:

```tsx
{ws.javascript && (
  <span class="flex items-center gap-1">
    <span class="inline-flex items-center justify-center size-4 rounded bg-primary text-primary-foreground text-[10px]">✓</span>
    JavaScript <span class="text-muted-foreground">(node_modules)</span>
  </span>
)}
{ws.python && (
  <span class="flex items-center gap-1">
    <span class="inline-flex items-center justify-center size-4 rounded bg-primary text-primary-foreground text-[10px]">✓</span>
    Python <span class="text-muted-foreground">(venv)</span>
  </span>
)}
```

No chip is rendered for an inactive mode — consistent with how the Git/Wiki chips already only appear when set.

---

## Error handling

- **Provisioning failure at creation** (missing binary, non-zero exit): the directory created by `createWorkspaceDirectory` is removed, and the request fails with `400` and the underlying error message surfaced to the user (visible via the creation form's existing `error` signal display — no new UI error path needed). No DB row and no wiki domain are ever created in this case.
- **Neither box checked**: no new behavior — creation proceeds exactly as it does today.
- No new error paths on the frontend beyond wiring two more fields into the existing submit flow; the existing `error.value = err instanceof Error ? err.message : 'Failed to create.'` catch in `handleSubmit` already surfaces a provisioning failure returned by the API.

---

## Testing

### Unit (Mocha/Chai, `api/`)

New `api/src/services/workspace-provision.test.ts`:

- Neither flag set → `execFileFn` is never called.
- `javascript: true` only → `execFileFn` called once with `('npm', ['init', '-y'], { cwd: location })`.
- `python: true` only → `execFileFn` called once with `('python3', ['-m', 'venv', '.venv'], { cwd: location })`.
- Both set → called twice, JavaScript before Python.
- A rejected `execFileFn` call propagates (rejects) out of `provisionDependencyIsolation` and short-circuits the second command.

Extend `workspaces.handlers.test.ts` / `projects.handlers.test.ts` (both already use a temp directory and a real `WorkspaceStore`):

- Provisioning succeeds (stub `execFileFn` resolving) → the created workspace's `javascript`/`python` fields match the request.
- Provisioning fails (stub rejecting) → handler returns `400`, and the directory created for the workspace no longer exists on disk afterward.

### Unit (Jest, `ui/`)

New/extended `ui/src/pages/workspaces/index.test.tsx`:

- Both checkboxes are unchecked by default.
- Checking JavaScript and/or Python and submitting calls `createWorkspace`/`createProject` with the matching `javascript`/`python` booleans.
- Submitting with both left unchecked sends `javascript: false, python: false`.

### E2E (Playwright, `e2e/`)

Extend `e2e/tests/workspace-project.spec.ts`:

- Create a workspace with both isolation checkboxes checked → the detail page shows both chips, and provisioning actually succeeds against the real `npm`/`python3` on the runner.
- Create a workspace with neither checked → the detail page shows neither chip.

No new CI setup step is needed: the e2e job (`.github/workflows/tests.yml`) already runs on `ubuntu-latest`, which ships both `npm` (via `actions/setup-node`) and `python3` preinstalled.
