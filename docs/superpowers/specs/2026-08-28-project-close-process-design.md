# Project Close Process — Wiki Snapshot, Selective Merge, and Domain Archival

**Date:** 2026-08-28
**Status:** Draft
**Related:** [Issue #78](https://github.com/tkottke90/amazing-hashbrown/issues/78) (depends on [#77](https://github.com/tkottke90/amazing-hashbrown/issues/77), closed; write-restriction groundwork from #79 already shipped in PR #98)

---

## Problem

A project's lifecycle requires a formal close step, whether the win condition is met or the project is explicitly abandoned. Today `closeProjectHandler` is a stub: it just flips `projects.status` straight to `'closed'`. The real close process — snapshotting the project's ephemeral wiki, letting the user selectively carry pages forward into other domains, cleaning up installed dependencies, and archiving the wiki domain so it can never be written to again — doesn't exist. Without it, knowledge produced during a project is lost when the ephemeral wiki is eventually cleaned up, and workspace directories accumulate stale `node_modules`/`venv` artifacts.

The same close process applies whether the project is being closed (win condition met) or abandoned (explicitly given up on) — incomplete work carries as much learning as completed work, so both paths run identical steps and differ only in the terminal status and button labels.

---

## Non-goals

- Re-implementing the write-restriction guardrail itself (`allowedWikiId` scoping on the four write-capable wiki tools) — that shipped already in PR #98 for issue #79. This design adds one _new_ check (archived-domain rejection) alongside it, not a replacement.
- Any UI for editing a project's wiki pages before merge — Step 2 only lets the user pick which existing pages go where, not edit their content.
- Deleting the project's ephemeral wiki domain on close. Closing archives it (read-only, permanent); deletion still only happens when the workspace itself is deleted (existing `deleteWorkspaceHandler`/`registry.destroy()` behavior from #77).
- Revisiting/undoing a close once `complete-close` has run. `closed`/`abandoned` are terminal.
- Stepper back-navigation. The close flow is forward-only (Continue/Skip advances; there's no path to re-open a completed step once passed).

---

## Data model & state machine

```
active → closing → closed
active → closing → abandoned
```

`closing` only ever moves forward — there's no path back to `active`.

**Migration 25** (next available version after 24, per `workspace-store.ts`'s version-numbering comment) on `projects`:

```sql
ALTER TABLE projects ADD COLUMN close_intent TEXT;
ALTER TABLE projects ADD COLUMN snapshot_path TEXT;
ALTER TABLE projects ADD COLUMN close_progress TEXT; -- JSON
```

- `status` stays an unconstrained `TEXT` column (matching the existing pattern — this schema has no `CHECK` constraints anywhere today), now taking the additional value `'closing'`, enforced at the app layer only. The `WorkspaceStatus`/`Project['status']` TypeScript unions gain `'closing'`.
- `close_intent`: `'close' | 'abandon' | null`. Set the moment a project enters `closing`; read back on Step 4 to pick the terminal status and the final button's label ("Complete close" vs. "Complete abandonment").
- `snapshot_path`: set once Step 1's snapshot succeeds. This is the durable marker that Step 1 is done — a page reload checks `snapshotPath !== null` rather than re-deriving anything.
- `close_progress`: a JSON blob, `{ mergeSelections?: { filename: string; targetDomainId: string }[]; dependencySelections?: { removeNodeModules: boolean; removePythonEnv: boolean } }`. Each key is written (via `PATCH /api/v1/projects/:id`) the moment its step's Continue or Skip is clicked (Skip writes an empty array / all-`false` object). A key's presence — not its content — is what marks that step complete.

**Current step is derived, not stored**, from these three persisted fields:

```
!snapshotPath                          → Step 1
closeProgress.mergeSelections === undefined       → Step 2
closeProgress.dependencySelections === undefined  → Step 3
otherwise                              → Step 4
```

This is what makes "reload mid-close without losing progress" work for free: the persisted fields _are_ the progress, so there's nothing extra to reconstruct. Step 3's actual cleanup _execution_ doesn't need its own persisted flag — it's self-evidencing. Once directories are removed from disk, a reload's directory scan simply finds none, which the existing "no `javascript`/`python` flags set and no matching directories found → step is skipped automatically with a notice" acceptance criterion already handles.

---

## API endpoints

### `POST /api/v1/projects/:id/close`

Body: `{ intent: 'close' | 'abandon' }`.

Replaces today's stub. Validates `intent` is one of the two allowed values (400 otherwise). Requires `project.status === 'active'` (409 otherwise — same "already closed" shape the existing `closeProjectHandler` already returns for a re-close attempt). Sets `status = 'closing'`, `close_intent = intent`.

### `PATCH /api/v1/projects/:id` (existing route, extended)

`PatchProjectInput` gains an optional `closeProgress` field. No new endpoint — each step's Continue/Skip sends the updated JSON blob through the route the app already has.

### `POST /api/v1/projects/:id/snapshot` (new)

Step 1's action, called automatically when the close page first loads (and again by the retry button on failure). Idempotent: if `snapshot_path` is already set, returns it immediately without re-running.

- Non-git workspace: copies the wiki domain's directory to `{workspace.location}/wiki-snapshot-{ISO date}/`.
- Git-connected workspace (`workspace.git`): copies into `{workspace.location}/wiki/`, then shells out `git add wiki && git commit -m "Snapshot project wiki on close"` via `execFile('git', [...])` — same pattern already used for git status/branch detection in `workspace-files.ts`.

On success: sets `projects.snapshot_path`. On failure: `snapshot_path` stays `null`, the handler returns an error, and the UI shows a retry button — the flow cannot advance past Step 1 until this succeeds, per the issue's AC.

### `POST /api/v1/workspaces/:id/cleanup-dependencies` (new)

Body: `{ removeNodeModules: boolean, removePythonEnv: boolean }`. Response: `{ removed: string[], bytesFreed: number }`.

Computes each selected directory's size before removing it, then `fs.rm(path, { recursive: true, force: true })`. Every path is resolved and checked against `workspace.location` using the same containment logic already proven out in `workspace-location.ts` (`resolvePathUnderRoot`) — never allowed to traverse above the workspace root.

### `POST /api/v1/projects/:id/complete-close` (new)

Step 4's final action. In one handler:

1. Runs the selective merge — for each `{filename, targetDomainId}` in `closeProgress.mergeSelections`, reads the source page (`sourceWiki.readPage(filename)`) and writes it into the target domain (`targetWiki.commitPage({...})` — see [Merge-write mechanism](#merge-write-mechanism) below).
2. Sets `projects.status` (`'closed'` or `'abandoned'`, from `close_intent`) and `closed_at = now()`.
3. Calls `LlmWiki.archive()` (new method, below) on the project's own wiki domain to set `status: archived` in its `index.md` frontmatter.
4. Clears `close_progress` (no longer needed once the project is terminal).

If the merge fails partway through the page list, the handler stops before steps 2–4, leaves `status` at `'closing'`, and returns which pages succeeded and which failed, so the UI can retry just the failures rather than losing track of ones that already landed.

### Read/write gating (R11 — API half)

Every handler that writes to a wiki domain — the four existing write-capable tools (`wiki_create_page`, `wiki_update_page`, `wiki_add_cross_link`, `wiki_rebaseline_source`) plus the new merge-write path in `complete-close` — looks up `SELECT status FROM projects WHERE wiki_id = ?` for the _target_ domain and rejects (403 for the HTTP-reachable paths; the tool's existing rejection-message shape for the agent-facing ones) if that project's status is `'closed'` or `'abandoned'`. This is independent of, and in addition to, the existing `allowedWikiId` scoping from #79 — that check answers "is this agent allowed to touch this domain at all," this one answers "is this domain still writable by anyone."

---

## SDK-layer archival check (R11 — library half)

`LlmWiki` needs to reject writes independently of any DB lookup, by reading `status: archived` directly out of the wiki's own `index.md` frontmatter — so both checks must fail closed on their own, without relying on the other.

Rather than duplicating an "am I archived?" check into each of `commitPage`, `addCrossLink`, `saveRaw`, and `rebaselineSource` separately, the guard lives in the one place every mutating method already funnels through: `writeFileRel` (`llm-wiki.ts:693`). Before writing, it reads `index.md`'s frontmatter and throws if `status === 'archived'`.

One nuance: `writeFileRel` is also how `index.md` itself normally gets written (`commitPage`'s index-refresh). If the archival flip went through `writeFileRel` too, it would block itself the moment it tried to run. The clean fix is to make archiving _not_ go through `writeFileRel` at all: a new `LlmWiki.archive(): Promise<void>` method writes `index.md`'s frontmatter directly. That keeps the guard itself simple — unconditional on every `writeFileRel` call, no path special-casing needed, since the one write that must survive an archived wiki (the archival write itself) never reaches it in the first place.

```ts
// llm-wiki.ts
async archive(): Promise<void> {
  const raw = await readFileOr(this.abs(INDEX_FILE), '');
  const { data, body } = fm.parse(raw);
  await fs.writeFile(this.abs(INDEX_FILE), fm.serialize({ ...data, status: 'archived' }, body));
}

private async assertNotArchived(): Promise<void> {
  const raw = await readFileOr(this.abs(INDEX_FILE), '');
  const { data } = fm.parse(raw);
  if (data.status === 'archived') {
    throw new Error('This wiki domain is archived — writes are not permitted.');
  }
}

private async writeFileRel(rel: string, content: string): Promise<void> {
  await this.assertNotArchived();
  // ...existing write logic unchanged
}
```

### Merge-write mechanism

`complete-close` copies each selected page directly: `targetWiki.commitPage({ title, body, type, tags, sources, confidence, contested, contradictions })`, built from the parsed source page (`sourceWiki.readPage(filename)`). This deliberately bypasses `wiki-write.ts`'s duplicate-detection — that machinery exists to catch an _agent_ proposing content that might already exist; here the user has already explicitly chosen "move this specific page to this specific domain," so a duplicate-title warning would just be an unwanted extra confirmation on an already-confirmed action. The merge always runs before `archive()` in the same handler, so nothing it writes is ever blocked by the guard above.

---

## UI flow

### Triggering close

The project detail header (`ui/src/pages/workspaces/[id].tsx`) replaces today's single `Close project` button with two: `Close project` and `Abandon`. Both call `POST /:id/close` with the matching `intent`, then navigate to `/workspaces/:id/close`.

`WorkspaceDetailView` gains a status check on load: `active` renders normally (unchanged); `closing` redirects to `/workspaces/:id/close` via `route()` (same pattern `RootRedirect` already uses); `closed`/`abandoned` renders the existing detail page with action buttons (`Close`/`Abandon`/`Delete`, and the settings-drawer's edit affordances) conditionally hidden — the rest of the page (tabs, task board, chat) is already safe to show read-only, so this doesn't need a forked component.

### Close page (`/workspaces/:id/close`, new)

New page, `ui/src/pages/workspaces/close/[id].tsx`, routed in `app.tsx` alongside the other workspace routes. Breadcrumb: Workspaces / {name} / Close. A persistent left-sidebar stepper shows steps 1–4 with a checkmark on completed steps and the current step highlighted; it is not clickable (forward-only flow, no back navigation). The current step is derived from `snapshotPath`/`closeProgress` as described above, so a reload lands the user back on the correct step automatically.

- **Step 1 — Wiki Snapshot.** Fires `POST /snapshot` on mount if `snapshotPath` isn't already set. Shows a spinner during the call, then the snapshot path on success, or an error with a retry button. Can't advance until it succeeds.
- **Step 2 — Selective Merge.** Fetches `GET /api/v1/wiki/domains/:id/pages` (the project's own domain) for the checklist, and `GET /api/v1/wiki/domains` (filtered to exclude the project's own domain id) for each row's target-domain picker. "Select all"/"Deselect all" controls. "Continue" is disabled until every checked row has a target domain; it `PATCH`es `closeProgress.mergeSelections`. "Skip this step" `PATCH`es it as `[]` and advances.
- **Step 3 — Dependency Cleanup.** Scans `workspace.location` for `node_modules/` (if `workspace.javascript`) and `venv/`/`.venv/`/`__pycache__/` (if `workspace.python`), showing found directories with sizes; checkboxes default checked. "Clean up selected" calls `POST /cleanup-dependencies` and shows bytes freed. "Skip this step" bypasses cleanup. If neither flag is set, or nothing is found, the step auto-completes with a "nothing to clean up" notice instead of requiring user action — matching the AC and requiring no extra persisted state, since a re-scan on reload naturally finds nothing once cleanup has actually run.
- **Step 4 — Review & Close.** Read-only summary from `closeProgress` and `snapshotPath`: snapshot path; `{page title} → {target domain}` per merged page (or "No pages merged"); dependencies removed (or "No cleanup performed"). Final button label follows `close_intent` ("Complete close" / "Complete abandonment"). Click calls `POST /complete-close`, then `route()`s to the now-read-only project detail page.

---

## Error handling

| Case                                                                                     | Behavior                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot fails (Step 1)                                                                  | `snapshot_path` stays `null`; UI shows retry; flow can't advance                                                                                                          |
| `complete-close` merge fails partway                                                     | `status` stays `'closing'`; response lists succeeded/failed pages; UI offers per-page retry                                                                               |
| Write attempted against an archived domain (any of the 4 agent tools, or a future merge) | Rejected independently at the API layer (`projects.status` lookup) and the library layer (`index.md` frontmatter) — either check alone is sufficient to block it, per R11 |
| `POST /:id/close` with missing/invalid `intent`, or on a project not in `active` status  | 400 / 409 respectively, matching this handler family's existing validation style                                                                                          |
| `cleanup-dependencies` given a path that would escape `workspace.location`               | Rejected — reuses the containment already proven out in `workspace-location.ts`                                                                                           |

---

## Testing

Following this repo's established pattern (real `WorkspaceStore`/`WikiRegistry` instances against `mkdtempSync` temp dirs, no mocking):

- `workspace-store.test.ts`: migration 25's three new columns round-trip correctly; `closeProject`'s replacement (intent-aware `closing` transition) rejects a project not currently `active`.
- `projects.handlers.test.ts`: `/close` validates `intent` and requires `active` status; `/snapshot` covers both the git and non-git branches plus idempotency on a second call; `/complete-close` covers the full happy path (merge + status + archive) and the partial-merge-failure path (status stays `closing`, failed pages reported).
- `lib/llm-wiki`: new tests for the `writeFileRel` archival guard — every mutating method (`commitPage`, `addCrossLink`, `saveRaw`, `rebaselineSource`) rejects once `archive()` has run, and `archive()` itself correctly flips `index.md`'s frontmatter without going through the guard.
- `workspaces.handlers.test.ts`: `/cleanup-dependencies` — size calculation before removal, path containment rejection, `bytesFreed` accuracy.
- UI (Jest): the close page resumes at the correct step for each combination of persisted state on mount; the stepper renders no back-navigation affordance; the read-only project detail page hides `Close`/`Abandon`/`Delete`/edit actions for `closed`/`abandoned` projects but still renders tabs/task board/chat.
- E2E (Playwright): one full flow — create a project, add wiki pages to it, close it, let the snapshot run, merge one page into another existing domain, skip dependency cleanup, complete the close, then verify the project detail page is read-only and that a direct write attempt against the now-archived domain is rejected.

---

## Out of scope / non-goals (recap)

- The `allowedWikiId` write-restriction mechanism itself (#79/PR #98) — unchanged, this design adds an orthogonal archived-domain check alongside it.
- Editing wiki page content during Step 2 — only page selection and destination domain.
- Deleting the ephemeral wiki domain on close — it's archived (permanent, read-only), not removed; removal still only happens on workspace deletion (#77).
- Undoing or reopening a completed close.
- Stepper back-navigation / revisiting a completed step.
