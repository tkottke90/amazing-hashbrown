# Workspace File Actions (Upload, New File, New Folder) — Design

**Date:** 2026-09-18
**Status:** Draft
**Related:** [Issue #142](https://github.com/tkottke90/amazing-hashbrown/issues/142)

---

## Goal

Let users bring files into a workspace, and create new files/folders, directly from the Files tab — instead of the only paths in today being the agent writing files or an external tool/git operating on the directory directly.

This design covers three actions, bundled together because they share the same target-directory selection mechanism and the same tree-row icon UI: **upload one or more files**, **create a new empty file**, and **create a new folder**. All three land in a directory the user explicitly picks in the tree.

---

## Problem

The Files tab (`ui/src/pages/workspaces/files-tab.tsx`, `ui/src/pages/workspaces/file-tree.tsx`) can browse, open, edit, and (per #135) preview files, but has no write path for bringing new files in from outside the workspace, and no way to scaffold a new file or folder from the UI.

The tree (`file-tree.tsx`) is a plain recursive expand/collapse view with no concept of a "current" or "selected" directory — unlike a single-pane file browser, there's nothing today that says which directory an upload or a new file should land in. That selection mechanism is the first thing this design has to add before upload/create can mean anything.

---

## Non-goals

- HEIC/HEIF conversion at upload time — filed as a future enhancement on #142, not required here.
- Drag-and-drop upload — file-picker only for this pass.
- Overwrite-on-conflict or auto-rename behavior — collisions are rejected outright (see [Collision handling](#collision-handling)).
- Inline tree-row renaming (VS-Code-style edit-in-place) for new file/folder names — a modal dialog is used instead.
- Rollback of partially-written files if a disk error occurs mid-batch during upload.
- Any change to the existing `/files/*/content` GET/PATCH routes, classification rules, or the 2MB text-read guard from #135 — uploaded bytes are written as-is; the existing content-route rules apply if/when the file is later opened.

---

## Design

### Target directory selection

The tree gains a single piece of new state:

```ts
export const selectedFolderPath = signal<string | null>(null); // null = workspace root
```

Interaction rules on `FileTreeRow` (`file-tree.tsx`):

- Clicking a folder row's name/icon area sets `selectedFolderPath` to that folder's path. Clicking the **same already-selected** folder again clears the selection back to `null` (root).
- Clicking the chevron specifically toggles expand/collapse only (a separate click handler with `stopPropagation`) — it never changes selection.
- Clicking a file opens it (unchanged behavior) and clears `selectedFolderPath` back to `null`.
- The selected folder row gets a persistent highlighted background (`bg-muted`, the same class already used for `:hover`).

There is no visible "root" row in the tree (top-level entries are listed directly), so root's actions live in the tree header instead of a row.

### Action icons

Three lucide-preact icons — `Upload`, `FilePlus`, `FolderPlus` — appear in two places, each targeting a `dir` (relative path, `''` for root):

- **Header toolbar**, next to the existing Refresh button: always visible, always targets root (`dir: ''`).
- **Selected folder row**, in the existing `ml-auto` badge slot (alongside git-status/unsupported/oversize badges): only rendered when that row is the selected one, targets `dir: node.path`.

### Upload flow

A single hidden `<input type="file" multiple>` is shared across both icon locations. Clicking either Upload icon records the intended `dir` and programmatically clicks the input. On `change`, the selected `FileList` is posted as `multipart/form-data` (field name `files`) to:

```
POST /api/v1/workspaces/:id/files/upload?dir=<relative-dir>
```

On success (`201 { created: string[] }`), the frontend calls `loadFileTree(workspaceId, { force: true })`. On a `409` conflict response, the conflicting names are shown inline (reusing the `file-tree-error` display slot) rather than a modal — this is a rare, easily-retried case (rename or delete locally and re-pick files), not worth a dedicated dialog.

**Backend (`workspace-files.route.ts` / `.handlers.ts` / `.ts`):**

- `multer.memoryStorage()` (not `diskStorage`, unlike `wiki-upload.route.ts`) with `limits: { fileSize: 50 * 1024 * 1024, files: 20 }`. Memory storage is used deliberately: the handler must validate every filename in the batch (for collisions and invalid names) _before_ committing any bytes to disk, so a rejected batch never leaves a partial write behind.
- Multer errors (`MulterError`, e.g. file-too-large or too-many-files) are mapped to `413`, same pattern as `wiki-upload.route.ts`'s inline error-mapping middleware.
- Handler validates: `dir` resolves to an existing directory under the workspace (via a new `resolveTargetDir()` helper — see below); every filename passes `isValidLeafName()`; no filename collides with an existing entry in `dir`, and no two files in the same batch share a name.
- If any of the above fails, the entire batch is rejected (`400`/`409`, listing every problem name) — nothing is written.
- Otherwise, each file's buffer is written via `fs.writeFile` to `path.join(absoluteDir, filename)`, then `invalidateFileTreeCache(workspaceId)` is called and `201 { created: [...] }` is returned.

### New File / New Folder flow

Clicking either icon opens a `Modal` (the existing `@tkottke90/preact-dialog` component already used by `rate-modal.tsx`, `provider-modal.tsx`, etc.) with a single name `<input>` and Create/Cancel buttons. On submit:

```
POST /api/v1/workspaces/:id/files/directory   { dir, name }
POST /api/v1/workspaces/:id/files/file        { dir, name }
```

Both return `201 { path: string }` or `409 { error }` on collision. Backend validation is the same shape as upload: `resolveTargetDir()` + `isValidLeafName()` + existence check, then `mkdir(absPath, { recursive: false })` (directory) or `writeFile(absPath, '', { flag: 'wx' })` (file, empty content, `wx` flag so an exclusive-create failure surfaces as the collision case).

On success:

- Both: reload the tree, and expand the parent folder if it wasn't already expanded.
- New File only: immediately call the existing `openFile()` with the new node so it opens into an empty editor tab — no extra fetch needed since the content is known to be empty.

### Shared backend helpers (`workspace-files.ts`)

```ts
// dir === '' or undefined resolves to the workspace root itself. Otherwise
// delegates to resolveFilePathUnderWorkspace for containment, then stats the
// result to confirm it's actually a directory (distinct error from "missing").
async function resolveTargetDir(
  workspaceLocation: string,
  dir: string | undefined,
): Promise<string>;

// A single path segment: rejects empty/whitespace-only, ".", "..", and any
// name containing "/", "\", or a null byte. Deliberately more permissive
// than the wiki uploader's slug regex — ordinary filenames like
// "report v2.docx" must be allowed.
function isValidLeafName(name: string): boolean;
```

---

## Error handling

| Case                                                                                          | Behavior                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target `dir` doesn't exist / deleted concurrently                                             | 404 `Directory "<dir>" not found`                                                                                                                           |
| Target `dir` resolves to a file, not a directory                                              | 400 `"<dir>" is not a directory`                                                                                                                            |
| Any uploaded filename collides with an existing entry, or two files in the batch share a name | 409, whole batch rejected: `{ error, conflicts: [...names] }`                                                                                               |
| New file/folder name collides with an existing entry                                          | 409 `"<name>" already exists in this folder`                                                                                                                |
| Invalid name (empty, `.`/`..`, contains `/`, `\`, or null byte)                               | 400, same message style as existing `resolveFilePathUnderWorkspace` errors                                                                                  |
| File exceeds 50MB, or more than 20 files in one request                                       | 413, mapped from `MulterError`                                                                                                                              |
| Disk write fails mid-batch (upload)                                                           | 500; files already written in that batch are left as-is — no rollback, matching the existing PATCH handler's precedent of not rolling back on write failure |
| Uploaded file would classify as `unsupported`/oversize per #135's rules                       | Allowed at upload time — upload only writes bytes; #135's existing content-route rules govern what happens if/when it's later opened                        |
| Tree cache                                                                                    | All three new endpoints call `invalidateFileTreeCache(workspaceId)` on success                                                                              |

---

## Testing

### Backend

- `workspace-files.test.ts`: `isValidLeafName()` — valid/invalid cases; `resolveTargetDir()` — root, nested, missing, not-a-directory.
- `workspace-files.handlers.test.ts`: upload handler — success with multiple files, whole-batch-rejected-on-any-conflict, invalid name, size/count limit errors; create-file and create-directory handlers — success, collision, invalid name, missing parent directory.

### Frontend

- `use-workspace-files.test.ts`: selection select/deselect/clear-on-file-click; upload request wiring and tree reload on success; create-file auto-opens a tab; create-folder expands its parent.
- `file-tree.test.tsx`: header icons always present and target root; row icons render only on the selected row; chevron click doesn't affect selection; selected-row highlight renders.

### E2E

Extend `e2e/tests/003-WorkspaceFileBrowser.spec.ts`:

| Action                                                 | Expected outcome                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Upload a file with the header (root) icon              | File appears at the tree root without a manual refresh                   |
| Select a nested folder, upload a file there            | File appears nested under that folder                                    |
| Upload a file whose name collides with an existing one | Rejected with an inline conflict message; nothing added to the tree      |
| Create a new file via the modal                        | File appears in the tree and opens in an empty editor tab                |
| Create a new folder inside a selected parent folder    | New folder appears nested under the parent, which is expanded to show it |

---

## Follow-up (out of scope, filed separately)

- HEIC/HEIF-to-web-format conversion at upload time (already noted on #142).
- Drag-and-drop upload.
