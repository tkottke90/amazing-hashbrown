# Project Ephemeral Wiki — Creation and Cleanup

Design for [#77](https://github.com/tkottke90/amazing-hashbrown/issues/77).

## Problem

Every project needs its own dedicated, ephemeral wiki domain that exists for
the lifetime of the project and is cleaned up when the project is deleted.
Without this, the project wiki write restriction (#79, future work) has
nothing to enforce against, and the project close process (#78, future work)
has no wiki to snapshot.

## Storage: reuse `workspaces.wiki_id`

The issue as originally written asks for a new `projects.wiki_id` column.
This design instead **reuses the existing `workspaces.wiki_id` column**
(added in migration v18) — no new column, no new migration.

Why: `workspaces.wiki_id` already exists as a nullable `TEXT` column, but is
currently unused — a free-text field with no UI input to set it and no
`WikiRegistry` wiring behind it. `createProject` already creates the
`workspaces` row and `projects` row together in one transaction, sharing a
single id, and `projects.workspace_id` is `UNIQUE` — a workspace has at most
one project. So "the project's wiki" and "the workspace's wiki" are the same
concept in this data model; a second column would just duplicate the first.

Domain id naming convention (per the issue): `project-{id}`, where `id` is
the shared workspace/project id.

## Library changes (`lib/llm-wiki`)

Two gaps block the acceptance criteria and don't exist in the library today:

1. **`index.md` has no YAML frontmatter mechanism.** The issue requires
   `type: ephemeral` / `status: active` in `index.md` frontmatter (read
   directly by future write-restriction logic, without a DB lookup).
2. **`WikiRegistry.remove()` only edits `registry.json`.** Its own doc
   comment says "Does not touch disk files" — cleanup needs a real delete.

Both are addressed generically (not project-specific), so #78 and #79 can
reuse them:

- `CreateWikiInput.metadata?: Record<string, string>` — when present,
  `LlmWiki.create()` writes a YAML frontmatter block at the top of
  `index.md`. Called with `{ type: 'ephemeral', status: 'active' }` for
  project wikis.
- `WikiRegistry.destroy(id): Promise<void>` — resolves the wiki's path,
  `fs.rm(path, { recursive: true, force: true })`, then calls the existing
  `remove(id)` to drop the registry entry.

Both are additive; no existing caller's behavior changes.

## Wiki creation flow (`createProjectHandler`)

Wiki filesystem operations are async; `WorkspaceStore.createProject`'s
transaction is synchronous (better-sqlite3). Orchestration happens in the
handler:

1. Validate the request body (unchanged).
2. Generate the shared `id` in the handler. `WorkspaceStore.createProject`
   changes to accept `id` as a parameter instead of generating it
   internally — its only caller is this handler, so this is a safe
   signature change.
3. `domainId = `project-${id}``. Compute `domain = slugify(body.name)`
   (lowercase, non-alphanumeric runs replaced with `-`, trimmed — no
   existing slugify utility or dependency in the repo, so add a small local
   helper). Call
   `registry.create({ id: domainId, name: body.name, domain, metadata: { type: 'ephemeral', status: 'active' } })`
   via `getWikiRegistry()`.
4. On success, call
   `store.createProject({ ...body, location, id, wikiId: domainId })`
   (existing sync transaction, now also stamping `wiki_id` on the
   `workspaces` insert).
5. If step 4 throws, `await registry.destroy(domainId)` to remove the
   orphaned wiki directory, then return/rethrow the original error.
6. If step 3 fails, return an error immediately — no DB rows are touched.

## Wiki cleanup flow (`deleteWorkspaceHandler`)

Currently synchronous; becomes `async`:

1. Before deleting: read `workspace = store.getWorkspace(id)` and
   `project = store.getProject(id)`.
2. Run the existing `store.deleteWorkspace(id)` (unchanged sync
   transaction — cascades `task_queue` → `tasks` → `projects` →
   `workspaces`).
3. If the delete succeeded, `project` existed, and `workspace.wikiId` was
   set: `await registry.destroy(workspace.wikiId)`, best-effort — log a
   warning on failure rather than failing the request, since the DB rows
   are already gone. (This matches the issue's own rationale: DB-first is
   safe because a stuck filesystem delete is recoverable; a stuck DB
   delete after the files are gone is not.)
4. `workspaces.route.ts`'s DELETE handler becomes `async` to match.

A workspace that never had a project attached keeps its `wiki_id` on
delete untouched, even if one was manually set — deletion cleanup is scoped
to project-provisioned wikis only.

## Lock enforcement (`patchWorkspaceHandler`)

Once a project is attached, `wiki_id` cannot be changed. `patchWorkspaceHandler`
checks `store.getProject(id)`: if it exists and `patch.wikiId !== undefined`,
return `400 Bad Request` ("wiki_id is locked once a project is attached")
rather than silently dropping or applying the change. Workspaces without a
project keep today's free-edit behavior (no UI path exercises it, but the
API still allows it).

## UI changes

`ui/src/pages/workspaces/[id].tsx:192-197` — the "Wiki" card in the Overview
tab. Replace the plain-text display with a link when `wikiId` is set,
following the existing navigation pattern from
`ui/src/pages/wiki/index.tsx:48-49`:

```tsx
{
  workspace.wikiId ? (
    <a
      href={`/wiki?view=document&domain=${encodeURIComponent(workspace.wikiId)}`}
      class="text-sm text-primary underline underline-offset-2"
    >
      {workspace.wikiId}
    </a>
  ) : (
    <p class="text-sm text-muted-foreground">Not linked</p>
  );
}
```

The read-only display in `workspace-settings-drawer.tsx:138-143` is out of
scope — the acceptance criterion only calls out the Overview tab, and that
spot is a compact metadata summary, not a natural place for a nav link.

## Testing

Following this repo's established pattern (real `WorkspaceStore` /
`WikiRegistry` instances against `mkdtempSync` temp dirs, no mocking):

- `lib/llm-wiki`: unit tests for `metadata` → frontmatter written into
  `index.md`, and `destroy()` removing both the registry entry and the
  on-disk directory (including a partially-created dir, for the rollback
  path).
- `api/src/routes/v1/projects.handlers.test.ts`: extend `createProjectHandler`
  tests — happy path creates a wiki domain and stamps `workspace.wikiId`;
  a DB failure after wiki creation triggers `destroy()` (verify the
  directory is gone).
- `api/src/routes/v1/workspaces.handlers.test.ts`: extend
  `deleteWorkspaceHandler` tests — deleting a workspace with an attached
  project destroys its wiki; deleting a project-less workspace with a
  manually-set `wikiId` leaves it untouched; `patchWorkspaceHandler` rejects
  a `wikiId` change once a project exists.
- UI: existing Jest coverage for the Overview tab gets a case asserting the
  wiki link renders with the right `href` when `wikiId` is set, and the
  "Not linked" fallback otherwise.

## Out of scope / non-goals

- No backfill for existing workspaces that already have a project but no
  `wiki_id` (none should exist yet in practice, but flagging it as a known
  gap).
- `workspaces.wiki_id`'s general free-edit path (for project-less
  workspaces) is untouched — no new validation beyond the project-lock
  check.
- Project close/snapshot behavior (#78) and write-restriction enforcement
  (#79) are not implemented here — this design only sets up the
  `metadata`/frontmatter mechanism they'll consume.
