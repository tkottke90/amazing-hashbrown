# Workspace File Browser — Design

**Date:** 2026-08-25
**Status:** Draft
**Related:** [Issue #74](https://github.com/tkottke90/amazing-hashbrown/issues/74)

---

## Goal

Replace the "File browser coming soon" stub in the workspace detail view's Files tab with a real file tree + editor: browse a workspace's directory, see uncommitted git status, open multiple files in tabs, edit them with a real syntax-highlighted editor, and save changes back to disk.

---

## Problem

Users working in a workspace currently have no way to inspect or modify the files the agent has produced without leaving the app for their local filesystem or IDE. The Files tab (`ui/src/pages/workspaces/[id].tsx:415-417`) is a placeholder. There is no file-serving API, no git-status integration, and no code-editing component anywhere in the app — the closest existing pieces are read-only markdown rendering (`highlight.js` + `rehype-highlight`) and the `execFile`-based shell-out pattern already used for workspace provisioning (`workspace-provision.ts`).

---

## Non-goals

- Any locking/conflict-resolution mechanism for concurrent writers — confirmed by the issue as a direct-overwrite, last-write-wins model (single user, single agent, same workspace).
- Live/real-time updates while the tab is open (websocket or filesystem watcher). Confirmed as out of scope for v1 — see [Refresh strategy](#refresh-strategy--caching) below.
- Honoring `.gitignore` for tree filtering — a fixed exclude list is used instead (see [Tree filtering](#tree-building--filtering)).
- Diffing, blame, commit/stage/push actions, or any other git write operation — this feature only reads git status for display.
- Persisting open tabs/buffers across a page reload or navigating away from the Files tab — acceptable to lose in-progress edits in that case, consistent with there being no autosave.
- IntelliSense-style completions, linting, or any language-server integration in the editor.

---

## Design

### API endpoints

New router `api/src/routes/v1/workspace-files.route.ts` + `workspace-files.handlers.ts`, mounted under the existing workspaces router, following the `workspaces.route.ts` / `.handlers.ts` split (thin Express handlers delegating to a `HandlerResult`-returning function, same `ok`/`notFound`/`badRequest` helpers as `workspaces.handlers.ts`):

- `GET /api/v1/workspaces/:id/files` → `{ branch: string | null, entries: FileNode[] }`
- `GET /api/v1/workspaces/:id/files/*path` → file content as `text/plain`
- `PATCH /api/v1/workspaces/:id/files/*path`, body `{ content: string }` → `200` on success

```ts
interface FileNode {
  name: string;
  path: string; // relative to workspace root, forward-slash separated
  type: 'file' | 'dir';
  children?: FileNode[]; // only on type: 'dir'
  gitStatus?: 'M' | 'A'; // only on type: 'file', only when the workspace has git enabled
}
```

### Path containment

Every `*path` request resolves against `workspace.location` and must land strictly inside it — the same safety boundary `resolvePathUnderRoot` already enforces for workspace directory names (`workspace-location.ts:23-41`), reused here rather than reimplemented: reject `..`, an embedded absolute path, or any resolved path whose containing tree walk escapes `workspace.location`.

### Tree building & filtering

A new `workspace-files.ts` service recursively walks `workspace.location`, always excluding `.git`, `node_modules`, and `.venv` at any depth — a fixed list, not `.gitignore`-driven. These three cover every directory a workspace can currently produce on its own (git metadata, the JS/Python isolation directories from `workspace-provision.ts`), and a fixed list has no parsing edge cases (nested `.gitignore`s, non-git workspaces, gitignore syntax) and needs no new dependency.

### Git status overlay

When `workspace.git` is `true`, shell out to `git status --porcelain` and `git branch --show-current` in `workspace.location`, using the same injectable `execFileFn` pattern as `provisionDependencyIsolation` (`workspace-provision.ts:20-34`) so tests can stub it instead of depending on a real git binary/repo.

Porcelain output is parsed into a `Map<relativePath, 'M' | 'A'>`: any `M` in either the staged or unstaged column → `M`; untracked (`??`) or staged-add → `A`. This map is overlaid onto the walked tree by relative path. Deleted-on-disk files require no handling — they never appear in a filesystem walk, so no `D` status is needed.

When `workspace.git` is `false`, `branch` is `null` and no node in the tree gets a `gitStatus`.

### Refresh strategy & caching

The tree (including the git overlay) is cached server-side in a module-level `Map<workspaceId, { tree, fetchedAt }>` with a short TTL (15s), following the existing precedent in `wiki-upload-store.ts:32,55`. This means:

- A background agent editing files is reflected within one TTL window, without any new infrastructure (no filesystem watcher, no event bus). This is a deliberate v1 tradeoff: the task-scheduler integration point that could push a real invalidation signal (`registerQueueBroadcast()` / `completeQueueEntry()` in `task-scheduler.ts`) is a designed-but-currently-unwired extension point — nothing calls it yet, so there is no real "agent finished writing" signal to hook into today. A TTL avoids building infrastructure against a hook that doesn't exist yet.
- A successful `PATCH` immediately invalidates that workspace's cache entry (write-through), so the user's own Save is always reflected on the next tree fetch, regardless of TTL.
- The UI has no polling. The tree is fetched when the Files tab is opened, again after a Save, and on-demand via an explicit refresh control in the tree header — all of which are cache-aware fetches (fast within the TTL window, otherwise trigger a fresh walk + git shell-out).

### Binary / oversized file guard

Both the content `GET` and `PATCH` reject (`422`) when a file exceeds a size cap (2MB) or a sniff of its first few KB contains a null byte / fails UTF-8 decoding. The UI shows "Can't display this file" in place of a tab rather than opening one with garbled or huge content.

### Frontend structure

New files, mirroring the existing `workspaces-api.ts` / `use-workspaces.ts` split:

- `ui/src/services/workspace-files-api.ts` — `fetchFileTree`, `fetchFileContent`, `saveFile`
- `ui/src/hooks/use-workspace-files.ts` — tree state (entries/branch/loading/error), expanded-folders set, open tabs, active tab
- `ui/src/components/file-tree.tsx` — recursive tree (expand/collapse, status badges, click-to-open, error state)
- `ui/src/components/code-editor.tsx` — CodeMirror 6 wrapper
- A `FilesTab` component replacing the stub at `[id].tsx:415-417`, laid out per the mockup: 250px tree + `flex: 1` editor panel, both `border: 1px solid var(--border); border-radius: 12px; height: 480px`

### Editor

CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, plus per-language packages for JS/TS, Python, JSON, Markdown, HTML, and CSS, with a plain-text fallback for any other extension). Chosen over Monaco: CodeMirror is designed for embedding in a page (small bundle, no web-worker setup required for basic syntax highlighting), which fits this Preact/Vite app better than pulling in the full VS Code editor engine. Theme swaps light/dark via the app's existing `useTheme()` hook so it matches the rest of the UI.

### Tab / buffer model

Per open file, in-memory only (lost on navigating away from the Files tab or a page reload — no persistence, consistent with [Non-goals](#non-goals)):

```ts
interface OpenFile {
  path: string;
  view: EditorView; // owns the live buffer — never mirrored into a signal
  savedContent: string; // last content confirmed written (open time or last successful save)
  dirty: Signal<boolean>; // one signal per tab, not a shared array/object signal
  error?: string;
}
```

- **Opening a file**: if already open, activate its tab. Otherwise `GET` its content (or show the binary/oversized error state) and push a new tab with `dirty = false`.
- **Save**: `PATCH` with `view.state.doc.toString()` read once, at click time. On success: `savedContent` updated, `dirty.value = false`, and the tree is re-fetched (now cheap — the cache was just invalidated) so the file's status badge updates. On failure: inline error shown, buffer and `dirty` state untouched.
- **Discard**: resets the view's document directly from the stored `savedContent` string; does not touch the filesystem.
- **Closing a dirty tab**: `confirm()` guard, consistent with the existing delete/close-project pattern already in `[id].tsx:294,300`.

### Performance: input handling & dirty tracking

Typing must not degrade with file size or with the number of open tabs. Two rules:

1. **CodeMirror's buffer is never mirrored into reactive state on keystroke.** The `EditorView` owns the live document and renders itself incrementally; no `useEffect`/signal write copies `doc.toString()` anywhere on every transaction. The only two places the full content is read are Save and Discard, both explicit, both once — not on a timer or on every keystroke.
2. **`dirty` is an O(1) event-driven flag, never a string comparison.** CodeMirror's `updateListener` extension exposes `tr.docChanged` — a boolean already computed by the transaction, not something this code diffs itself. On the first edit after opening/saving, `dirty.value` flips to `true` once; further keystrokes in the same editing session do nothing to `dirty` (already `true`, no-op write), so there is no per-character work at all on this path, regardless of file size.

Each tab owns its own `dirty` signal rather than all tabs sharing one array/object signal, so a keystroke in one tab only re-renders that tab's own unsaved-indicator dot — not the tree, not the editor chrome, not other open tabs' rows in the tab bar. Any future feature that needs the _live_ content for something other than Save/Discard (e.g. a char/line count) should read it via a debounced listener (~250ms after the last keystroke), not synchronously per transaction — no such feature exists in this design, but the rule is recorded here so it isn't reintroduced accidentally later.

---

## Error handling

| Case                                                     | Behavior                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Workspace directory missing/unreadable                   | `GET /files` returns a typed error; tree panel shows an error state instead of crashing |
| File deleted on disk after the tree loaded, then clicked | `GET` content 404s → the new tab shows an inline error instead of content               |
| Binary or oversized file clicked                         | Blocked by the server guard → "Can't display this file" shown in place of a tab         |
| Save fails (disk error, permission denied)               | Inline error shown near the Save button; buffer and `dirty` state preserved             |
| Non-git workspace                                        | No branch label in the tree header, no status badges; tree still fully functional       |
| Closing a dirty tab                                      | `confirm()` guard before discarding the in-memory buffer                                |

---

## Testing

### Backend (Mocha, co-located `.test.ts`, following `workspaces.handlers.test.ts` conventions)

- Tree walker: excludes `.git`/`node_modules`/`.venv` at any depth; nested directories; empty directory; non-existent root → typed error
- Git overlay: porcelain parsing → `M`/`A`; non-git workspace → no overlay; injectable `execFileFn` for tests (no real git binary/repo required)
- Cache: serves within TTL; invalidated immediately by a successful `PATCH`; expires and re-walks after TTL
- Content endpoint: path-containment rejection (`..`, absolute path, embedded separator — mirroring `resolvePathUnderRoot`'s existing test cases); binary/oversized-file rejection; happy path
- `PATCH`: writes file content, invalidates the cache entry, surfaces a write failure (e.g. a stubbed permission-denied error) as an error result

### Frontend (Jest + Preact Testing Library, matching existing component test conventions)

- `file-tree.tsx`: expand/collapse, status-badge rendering, error state on a failed fetch
- Tab/dirty-signal logic: `dirty` flips to `true` on the first edit and stays `true` across further edits; resets on save and on discard; independent per tab (editing one tab doesn't flip another's)
- Save/Discard wiring, including the failure path (inline error shown, buffer preserved)
- `code-editor.tsx`: mounts CodeMirror with the language extension matching the file's extension; falls back to plain text for an unrecognized extension; unmounts cleanly

### E2E (Playwright, new `e2e/tests/003-WorkspaceFileBrowser.spec.ts`)

This feature is reachable only through real browser interaction across a tree/viewer/tab-bar UI backed by real filesystem and git state, which is exactly the kind of behavior this repo's existing e2e suites exist to cover — so unlike the [wiki-binding form-wiring change](./2026-08-25-workspace-creation-wiki-binding-design.md), this warrants a new suite rather than relying on Jest alone.

This suite is authored against the `@tkottke90/playwrite-test-runner` library (`TestSuite`, `TAGS`, `suiteRunner`, `pauseForVideo`) — the pattern established in `001-ChatInterface.spec.ts` and `002-GitHubTrackerWorkflow.spec.ts` — rather than the older local `e2e/lib/suite.ts` (`suiteAnnotations` + a hand-written `test.describe`/`test()` block matching each step by convention), which is what `workspace-project.spec.ts` and most other existing suites still use. Concretely:

- `export const WorkspaceFileBrowser: TestSuite = { id: 18, name, purpose, tag: [TAGS.UserWorkflow], recordVideo: true, steps: [...] }`, `id: 18` following on from `inbox-tasks.spec.ts`'s `17`.
- Each step's `test` is the real Playwright test body inline (`test: async ({ page, request }, testInfo) => {...}`), not a placeholder matched up to a separately-written `test()` block — the runner generates the actual test from the step itself.
- `suiteRunner(WorkspaceFileBrowser)` at the bottom of the file — no manual `test.describe`/`suiteAnnotations` wiring.
- Steps use `tag: [TAGS.Smoke]` on the two or three steps that most directly cover the issue's core acceptance criteria (tree + git status on open, Save writing to disk), matching how `001`/`002` reserve `Smoke` for their most load-bearing steps rather than tagging everything.

Planned steps (action / expected outcome — `test` bodies are written during implementation, not here):

| Action                                                                                                                                         | Expected outcome                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Open the Files tab on a git-enabled workspace with an untracked and a modified file                                                            | Tree loads rooted at the workspace's `location`; header shows `git · <branch>`; the modified file shows `M`, the untracked file shows `A` |
| Expand and collapse a folder in the tree                                                                                                       | Children show/hide; state persists while switching tabs                                                                                   |
| Point a workspace at a missing/unreadable directory and open Files                                                                             | Tree panel shows a clear error state, not a crash                                                                                         |
| Open a workspace with `git: false`                                                                                                             | Tree loads with no branch label and no status badges                                                                                      |
| Click a file, then a second file                                                                                                               | Both open as tabs in the tab bar; content of each is shown when its tab is active                                                         |
| Edit an open file                                                                                                                              | Unsaved-dot appears on that tab only; other open tabs are unaffected                                                                      |
| Click Save on a dirty tab                                                                                                                      | Content is written to disk; unsaved-dot clears; that file's tree status badge updates                                                     |
| Edit a file, then click Discard                                                                                                                | Buffer reverts to last-saved content; nothing is written to disk                                                                          |
| Attempt to close a tab with unsaved changes                                                                                                    | A confirmation prompt appears before the tab closes                                                                                       |
| Click a binary file in the tree                                                                                                                | Viewer shows "Can't display this file" instead of a tab with garbled content                                                              |
| Save a file made read-only on disk                                                                                                             | Inline error is shown; the edited buffer is preserved, not reverted or lost                                                               |
| Edit a file directly on disk (bypassing the app), then reopen the Files tab before the TTL elapses, then again after using the refresh control | Tree does not reflect the change immediately (TTL cache); refresh control shows the update                                                |
