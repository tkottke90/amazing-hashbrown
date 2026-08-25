# Workspace Creation — Git Configuration — Design

**Date:** 2026-08-24
**Status:** Draft
**Related:** [Issue #69](https://github.com/tkottke90/amazing-hashbrown/issues/69)

---

## Goal

Let a user record a workspace's (or project's) git remote URL at creation time, and see it on the workspace detail page afterward.

---

## Problem

Workspaces represent codebases the agent works on, and many of those codebases live in remote git repositories. The `workspaces` table already has a `remote_url` column and a `git` boolean (migration 18), the API already accepts and returns both fields on `POST/PATCH /api/v1/workspaces` and `POST/PATCH /api/v1/projects`, and the UI's `Workspace`/`CreateWorkspaceInput` types already include `remoteUrl`/`git`. But the creation form (`ui/src/pages/workspaces/index.tsx`) never surfaces these fields, so every workspace is created with `git: false` and `remoteUrl: null` regardless of intent — there's no way to record where the code lives, and the detail page's existing Git chip (`ui/src/pages/workspaces/[id].tsx`) never has anything to show.

---

## Non-goals

- Any API or database changes. `remote_url`/`git` are already fully wired end-to-end on the backend; this is a frontend-only change.
- Format validation/regex on the remote URL (rejecting malformed HTTPS/SSH strings). The existing "Remote URL" field in `WorkspaceSettingsDrawer` accepts free text with no validation today, and this feature should behave consistently with it.
- Changes to `WorkspaceSettingsDrawer` (the post-creation "Edit" drawer). The issue's developer notes scope UI changes to the creation form and the detail page only; the settings drawer's existing (unconditional) Remote URL field is out of scope for this change.
- Cloning, pulling, or otherwise acting on the remote URL. This feature only records and displays it.

---

## Design

### 1. Creation form (`ui/src/pages/workspaces/index.tsx`)

`CreateWorkspaceForm` gains two new signals:

```ts
const gitEnabled = useSignal(false);
const remoteUrl = useSignal('');
```

A new bordered section is rendered between the Goal textarea and the Project-mode-only fields block, for **both** Workspace and Project creation modes (a project is a workspace with extra fields, and shares the same `remote_url`/`git` columns — there's no reason to withhold git tracking from a project):

```tsx
<div class="border border-border rounded-lg p-3 flex flex-col gap-3">
  <div class="flex items-center justify-between gap-3">
    <div>
      <p class="text-sm font-medium">Git repository</p>
      <p class="text-xs text-muted-foreground">Track this workspace against a remote.</p>
    </div>
    <Switch
      checked={gitEnabled.value}
      onCheckedChange={(checked) => {
        gitEnabled.value = checked === true;
      }}
    />
  </div>
  {gitEnabled.value && (
    <div class="flex flex-col gap-1">
      <label class="text-xs font-medium text-muted-foreground">Remote URL</label>
      <Input
        placeholder="https://github.com/org/repo or git@host:org/repo.git"
        value={remoteUrl.value}
        onInput={(e) => {
          remoteUrl.value = (e.target as HTMLInputElement).value;
        }}
      />
    </div>
  )}
</div>
```

`Switch` is imported from `@/components/ui/switch` (existing component, already used with this same `checked`/`onCheckedChange` API in `ui/src/components/thread-sidebar.tsx`).

**Validation** (in `handleSubmit`, alongside the existing name/directory/win-condition checks):

```ts
if (gitEnabled.value && !remoteUrl.value.trim()) {
  error.value = 'Remote URL is required when Git is enabled.';
  return;
}
```

**Submit payload:** both the `createWorkspace(...)` and `createProject(...)` calls add:

```ts
git: gitEnabled.value,
remoteUrl: gitEnabled.value ? remoteUrl.value.trim() : null,
```

Computing `remoteUrl` from `gitEnabled.value` (not just `remoteUrl.value.trim() || null`) is what guarantees "toggle off → no remote URL stored" even if the user typed something into the field and then flipped the toggle off before submitting.

### 2. Detail page (`ui/src/pages/workspaces/[id].tsx`)

The metadata chip row already renders a Git chip conditionally on `ws.git`. It keeps its current appearance (icon + "Git" label, no layout change) and gains a `title` attribute carrying the full remote URL, shown as a native browser tooltip on hover:

```tsx
{
  ws.git && (
    <span class="flex items-center gap-1" title={ws.remoteUrl ?? undefined}>
      <GitBranch class="size-3" />
      Git
    </span>
  );
}
```

---

## Error handling

No new error paths beyond the existing form validation pattern already used for `name`/`directoryName`/`winCondition` — a missing required field sets the `error` signal and blocks submission, same as today. No new failure modes are introduced on the API side since the fields are already accepted.

---

## Testing

### Unit (Jest, `ui/`)

New test file `ui/src/pages/workspaces/index.test.tsx` (or extending one if it already exists) covering the creation form's Git section:

- Git toggle is off by default; the Remote URL input is not rendered.
- Toggling Git on reveals the Remote URL input.
- Submitting with Git on and an empty Remote URL shows a validation error and does not call `createWorkspace`/`createProject`.
- Submitting with Git on and a Remote URL calls `createWorkspace` (Workspace mode) or `createProject` (Project mode) with `git: true, remoteUrl: '<value>'`.
- Submitting with Git toggled off always sends `git: false, remoteUrl: null`, even if the Remote URL input had text in it before the toggle was switched off.

### E2E (Playwright, `e2e/`)

Extend `e2e/tests/workspace-project.spec.ts` (the existing workspace/project creation spec) to cover:

- Create a workspace with Git enabled and a remote URL set → the workspace detail page shows the Git chip, and its `title` attribute matches the entered URL.
- Create a workspace with Git left off → the detail page shows no Git chip.
