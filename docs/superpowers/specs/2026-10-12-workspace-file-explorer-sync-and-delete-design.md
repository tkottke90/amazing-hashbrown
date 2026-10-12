# Workspace File Explorer: Stale-File Sync, Agent-Assisted Conflict Resolution, and Delete — Design

**Date:** 2026-10-12
**Status:** Draft

---

## Goal

Two independent gaps in the Files tab:

1. Reopening an already-open tab shows stale, cached content with no indication the on-disk file has changed, and saving can silently clobber someone else's (or the agent's) more recent edit.
2. There is no way to delete a file or directory from a workspace via the UI at all.

Both are explicitly called out as deferred-for-later in the two prior Files-tab design docs (`2026-08-25-workspace-file-browser-design.md`'s "conflict resolution... single user, single agent, same workspace" and "no live updates" decisions; `2026-09-18-workspace-file-actions-design.md` never scoped delete).

---

## Problem

**Staleness.** `ui/src/hooks/use-workspace-files.ts`'s `openFile()` only fetches content the first time a tab is opened for a given path; reactivating an already-open tab is pure in-memory cache, forever. `patchFileContentHandler` (`api/src/routes/v1/workspace-files.handlers.ts`) does an unconditional `writeFile` — there is no mtime/hash/version concept anywhere in the file-content API, so a save always wins regardless of what changed on disk in between, including changes the harness's own agent made via `shell_exec` or a future file tool.

**Delete.** No `DELETE` route exists on `workspace-files.route.ts`, and `FileTreeRow`/`FolderActionIcons` (`ui/src/pages/workspaces/file-tree.tsx`) have no delete affordance. The closest precedents are `skills.route.ts`'s per-file delete and `workspaces.handlers.ts`'s whole-workspace recursive delete — both single-item, confirm-gated, best-effort removals, which this design follows.

---

## Non-goals

- Live/real-time updates while a tab is open (polling, websocket, filesystem watcher) — the check only runs on tab (re)activation, consistent with the prior design docs' "no live updates" decision.
- Multi-file/multi-select delete.
- Deleting the workspace root itself from the file tree — that stays the job of the existing dedicated delete-workspace flow.
- Solving merge _quality_ for Agent Resolve (i.e. prompt-engineering the model to produce better merges) — this design wires the mechanism; merge quality is a system-prompt/eval concern per this repo's EDD process.
- Rename, move, or copy.

---

## Design

### 1. Stale-file detection, auto-refresh, and conflict warning

**Hash as the staleness signal.** `GET /:id/files/*/content` starts returning a `contentHash` (SHA-256 of the file's bytes, computed server-side from bytes already read for the response — no extra disk I/O) alongside `content`. `OpenTab` (`use-workspace-files.ts`) gains a `baseHash: string` field, set on initial load and on every successful save.

**On tab reactivation** (clicking a tree node or tab strip entry for a path that already has an open tab):

| Tab state              | On-disk hash vs `baseHash`  | Behavior                                                                                                                                                                                                                   |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean (no local edits) | Unchanged                   | No-op                                                                                                                                                                                                                      |
| Clean                  | Changed                     | Silently replace editor content with the fresh content; update `baseHash`. This is the reported bug — comes back to the same content even though the file changed.                                                         |
| Clean                  | File no longer exists (404) | Tab shows a "file deleted on disk" state in place of the editor (no content to show) with a single "Close tab" action — no banner needed since there's no local work to protect.                                           |
| Dirty (local edits)    | Unchanged                   | Normal dirty state, no banner                                                                                                                                                                                              |
| Dirty                  | Changed                     | Editor content is **not** touched. Show a persistent conflict banner.                                                                                                                                                      |
| Dirty                  | File no longer exists (404) | Same banner, worded for deletion; only "Discard my edits" (closes tab) or a plain Save (recreates the file) apply — no Agent Resolve or Overwrite, since there's nothing on disk to merge against or explicitly overwrite. |

**The conflict banner** offers three actions:

- **Overwrite** — proceed to save, passing a `force: true` flag that bypasses the server-side hash check (see below). This is the explicit, deliberate version of today's implicit last-write-wins.
- **Discard my edits** — reload on-disk content into the editor, clearing dirty state and updating `baseHash`.
- **Agent Resolve** — see §2.

**Server-side enforcement at save.** The client's `PATCH /:id/files/*/content` body gains `baseHash: string` and optional `force?: boolean`. The handler re-reads and re-hashes the current file; if `force` is not set and the hash doesn't match `baseHash`, it returns `409 Conflict` using the existing-but-previously-unused `conflict()` helper in `workspace-files.handlers.ts`, instead of writing. This closes the actual race (UI staleness checks only run on reactivation; the server check is what makes the guarantee real) — a save attempted without ever having triggered the banner (e.g. two tabs on the same file in different windows) still gets rejected rather than silently overwriting.

### 2. Agent-assisted conflict resolution ("Agent Resolve")

**New gated tool — `propose_file_merge`.** Added to `api/src/agents/tool-catalog.ts`, signature `propose_file_merge({ path, mergedContent, explanation })`. Registered with `skill-gated-tools.middleware.ts` so it's invisible to the model during normal chat and only appears during a resolve turn. The tool has no filesystem access — it exists purely so the UI can read a structured result off the tool-call SSE event; nothing is written to disk by the tool itself.

**Trigger.** Clicking "Agent Resolve":

1. Switches the UI to the workspace's Chat tab.
2. Posts a message to the existing chat thread via the normal `POST /:threadId` SSE flow (same path a human-typed message takes). The message carries the skill-command token that activates the `propose_file_merge` gate, plus the file path, the user's current in-editor draft, and the latest on-disk content.
3. The message and the agent's subsequent reasoning/tool-call render in the thread like any other turn — the user watches it happen.

**Consuming the result.** The UI's existing SSE tool-call handling in `use-thread.ts` (`tool_call_start`/`tool_call_end`) picks up the `propose_file_merge` call. When it lands:

- The corresponding editor tab (open underneath, in the Files tab) has its draft replaced with `mergedContent`.
- The tab stays dirty.
- `baseHash` is refreshed to the current on-disk hash, so the next Save is treated as a normal edit rather than re-triggering the conflict.
- Nothing is written to disk automatically — the user reviews the proposal and explicitly clicks Save.

The agent's `explanation` renders as part of the tool call's summary in the transcript, giving the user a one-line account of what changed, without introducing a new `ThreadMessage` kind.

### 3. Delete files and directories

**API.** New route: `DELETE /:id/files/*` in `workspace-files.route.ts` (same wildcard pattern as the existing `GET`/`PATCH` content routes). Handler `deleteFileEntryHandler` in `workspace-files.handlers.ts`:

- Resolves and validates the path via the existing `resolveFilePathUnderWorkspace` (same containment check read/write already use).
- Rejects an empty relative path (the workspace root) with `400`.
- `fs.rm(absPath, { recursive: true, force: true })` — uniform for a single file or a directory tree, mirroring `removeWorkspaceDirectory`'s best-effort, never-throws pattern.
- `404` if the path doesn't exist; otherwise `ok({ deleted: true })`.
- Calls `invalidateFileTreeCache(workspaceId)` on success.

**UI.** Every `FileTreeRow` _except the root_ gets a delete icon alongside the existing hover action icons (upload/new-file/new-folder). Clicking it opens a confirm modal (the existing `Modal`/`useDialog` pattern from `CreateEntryModal`, copy extended from `delete-confirm-message.ts`); for a directory, the copy states the deletion is recursive. On confirm:

- Call the new `DELETE` endpoint.
- On success: close any open tab(s) whose path equals or falls under the deleted path, discarding drafts with no further confirmation (deleting is itself the deliberate, final action); refresh the file tree.
- On failure: error toast; tree and tabs left untouched.

---

## Error handling

| Case                                                       | Behavior                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Save with stale `baseHash`, no `force`                     | `409 Conflict`                                                                                                                           |
| Save with `force: true`                                    | Proceeds unconditionally, same as today's behavior                                                                                       |
| Reactivated tab, file deleted on disk                      | `404` from the hash-check call; dirty tab shows delete-specific banner; clean tab shows a "file deleted" state and closes-on-acknowledge |
| `propose_file_merge` called outside an active resolve turn | Not reachable — tool is gated out of the model's tool list entirely                                                                      |
| `DELETE` on workspace root (empty path)                    | `400`                                                                                                                                    |
| `DELETE` on missing path                                   | `404`                                                                                                                                    |
| `DELETE` disk error mid-removal                            | `500`; partially-removed directory tree left as-is, no rollback (matches existing PATCH precedent of not rolling back on failure)        |
| Delete removes a path with open tab(s)                     | Tabs closed, drafts discarded, on successful API response only                                                                           |

---

## Testing

### Backend (Mocha + Chai, adjacent `*.test.ts`)

- `workspace-files.handlers.test.ts`: `contentHash` present on GET; PATCH succeeds when `baseHash` matches; PATCH returns `409` on mismatch; PATCH with `force: true` bypasses the check; new delete handler — success (file), success (directory, recursive), `404` on missing path, `400` on root path.
- `tool-catalog`/`skill-gated-tools.middleware` tests: `propose_file_merge` excluded from the agent's tool list when the gate isn't active, included when it is.

### Frontend (Jest + Testing Library)

- `use-workspace-files.test.tsx`: reactivation matrix from the table in §1 (clean/dirty × changed/unchanged/deleted); save conflict handling (409 → banner state); tab closing on delete.
- `file-tree.test.tsx`: delete icon renders on every row except root; confirm modal flow (confirm removes row, cancel leaves it).

### E2E (Playwright, `@user-workflow`)

Extend `e2e/tests/003-WorkspaceFileBrowser.spec.ts`:

| Action                                                                                  | Expected outcome                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Edit a file on disk outside the app, switch tabs away and back (tab was clean)          | Editor shows the new content with no manual action                                                         |
| Make an edit in a clean tab's underlying file, then edit the file on disk before saving | Conflict banner appears with Overwrite/Discard/Agent Resolve                                               |
| Click Overwrite                                                                         | Save proceeds, on-disk content replaced with editor content                                                |
| Click Discard my edits                                                                  | Editor reloads on-disk content, dirty state clears                                                         |
| Click Agent Resolve (SSE tool-call mocked via `page.route()` per `e2e/AGENTS.md`)       | UI switches to Chat tab; once the mocked tool call resolves, the Files tab's editor shows the merged draft |
| Delete a file via its row's delete icon + confirm                                       | File disappears from tree; if it was open, its tab closes                                                  |
| Delete a folder via its row's delete icon + confirm                                     | Folder and its contents disappear from tree; any open tabs under it close                                  |

### EDD requirement

`propose_file_merge` is new LLM-facing behavior, so per this repo's EDD rule 1, a failing `tool-call`-type eval scenario (model calls `propose_file_merge` with sane arguments given a conflict prompt) must be written before implementation and made to pass before merge. This repo's agent sessions can't reach local model providers, so that run is handed off to the user to execute once the scenario is written.

---

## Follow-up (out of scope, filed separately)

- Rename/move within the tree.
- Multi-select delete.
- Improving `propose_file_merge` merge quality via system-prompt iteration against real eval runs.
