# Workspace Creation — Wiki Binding — Design

**Date:** 2026-08-25
**Status:** Draft
**Related:** [Issue #71](https://github.com/tkottke90/amazing-hashbrown/issues/71)

---

## Goal

Let a user bind a wiki domain to a workspace at creation time via a select field on the creation form, wired into the storage, project auto-provisioning, and detail-page display that already exist.

---

## Problem

The `workspaces` table already has a `wiki_id` column (migration 18), and `WorkspaceStore` already reads/writes it end-to-end. The workspace detail page (`ui/src/pages/workspaces/[id].tsx`) already shows the bound wiki with a link, or "Not linked" when unset. `createProjectHandler` already auto-provisions an ephemeral wiki domain via `WikiRegistry` and locks `wiki_id` once a project exists (`patchWorkspaceHandler` rejects a `wikiId` change when `store.getProject(id)` returns a project).

What's missing is the only user-facing input for this: the creation form (`ui/src/pages/workspaces/index.tsx`) has no wiki-binding field at all, and `wikiId` is never included in the `createWorkspace`/`createProject` submit payloads. Every workspace today is created with `wiki_id` implicitly `null`.

One correction to the issue's dev notes: `GET /api/v1/wiki/domains` (`wiki.route.ts:28-40`) returns `{ id, domain, tags }[]`, not `{ id, name, domain, tags, routingNotes }[]`. The registry's `WikiEntrySchema` (`lib/llm-wiki/src/registry.ts:30-36`) has no `name` field — the `name` passed to `WikiRegistry.create()` is written into the wiki's own `SCHEMA.md`/frontmatter, not persisted in `registry.json`. `routingNotes` is a registry-wide array, not per-entry. This design uses `domain` as the select's display label, matching the mockup's plain-word style (`homelab`, `nas-migration`) and requiring no API change.

---

## Non-goals

- Any change to `WorkspaceStore`, the `workspaces` table, `NewWorkspaceInput`/`PatchWorkspaceInput`, or `patchWorkspaceHandler`'s lock — all already correct.
- Any change to `GET /api/v1/wiki/domains`'s response shape, or to `WikiRegistry`/`llm-wiki` generally.
- Changes to the workspace detail page's wiki display or to `workspace-settings-drawer.tsx` — both already handle `wikiId` per the prior [Project Ephemeral Wiki design](./2026-08-24-project-ephemeral-wiki-design.md).
- An edit path for `wikiId` on an existing project-less workspace. The settings drawer shows it read-only today; adding an edit UI there is separate scope.
- A shared/global hook for the domains list — it's only needed while the creation drawer is open, so `CreateWorkspaceForm` fetches it locally, following the existing precedent of drawer-local state (`javascriptEnabled`, `gitEnabled`, etc. in the same file).

---

## Design

### Frontend — creation form (`ui/src/pages/workspaces/index.tsx`)

`CreateWorkspaceForm` gains new state:

```ts
const NONE_WIKI_VALUE = '__none__'; // Radix Select can't use '' as an item value

const wikiId = useSignal<string>(NONE_WIKI_VALUE);
const wikiDomains = useSignal<WikiDomain[]>([]);
const wikiDomainsLoading = useSignal(true);
const wikiDomainsError = useSignal(false);
```

A `useEffect(() => {...}, [])` on mount calls the existing `fetchDomains()` from `@/services/wiki-api` (no new service code):

```ts
useEffect(() => {
  fetchDomains()
    .then((domains) => {
      wikiDomains.value = domains;
    })
    .catch(() => {
      wikiDomainsError.value = true;
    })
    .finally(() => {
      wikiDomainsLoading.value = false;
    });
}, []);
```

**Workspace-mode select**, placed after the Goal textarea and before the Git repository block, rendered only when `mode.value === 'workspace'`:

```tsx
<div class="flex flex-col gap-1">
  <label class="text-xs font-medium text-muted-foreground">Wiki binding</label>
  <Select
    value={wikiId.value}
    onValueChange={(v) => {
      wikiId.value = v;
    }}
  >
    <SelectTrigger class="w-full" disabled={wikiDomainsLoading.value || wikiDomainsError.value}>
      <SelectValue>
        {wikiId.value === NONE_WIKI_VALUE
          ? 'None'
          : (wikiDomains.value.find((d) => d.id === wikiId.value)?.domain ?? 'None')}
      </SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={NONE_WIKI_VALUE}>None</SelectItem>
      {wikiDomains.value.map((d) => (
        <SelectItem key={d.id} value={d.id}>
          {d.domain}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
  <p class="text-xs text-muted-foreground">Sets the first lookup, not an exclusive scope.</p>
  {wikiDomainsError.value && (
    <p class="text-xs text-destructive">
      Couldn't load wiki domains — check the wiki registry config.
    </p>
  )}
</div>
```

**Project-mode text**, rendered only when `mode.value === 'project'`, in the same position:

```tsx
<p class="text-xs text-muted-foreground">
  Creates an ephemeral wiki domain — the only write target while the project is active.
</p>
```

(No specific domain id is known client-side before submit — `project-{id}` is generated server-side in `createProjectHandler` — so this omits the `<code>project-nas-migration</code>` detail the mockup shows and states the behavior generically.)

**Submit payload**, both `createWorkspace(...)` and `createProject(...)` calls add:

```ts
wikiId: mode.value === 'workspace' && wikiId.value !== NONE_WIKI_VALUE ? wikiId.value : null,
```

Project mode always sends `null`; the backend already ignores/overrides this with the auto-created domain id in `createProjectHandler`, but sending `null` keeps the payload honest about what this form actually controls.

**Submit blocking on fetch failure:** `wikiDomainsError.value` is added to the submit `Button`'s existing `disabled={saving.value}` condition, and `handleSubmit` gets an early-return guard for the same condition (defense in depth, matching the existing `saving.value` pattern) — so the form cannot be submitted until the domains list has loaded successfully.

### No backend changes

`createWorkspaceHandler` already spreads `body` (including any `wikiId`) into `store.createWorkspace()`. `createProjectHandler` already computes and stamps its own `wikiId`. `CreateWorkspaceInput`/`CreateProjectInput` in `ui/src/services/workspaces-api.ts` already declare `wikiId?: string | null`. Nothing here needs to change.

---

## Error handling

- **Domains fetch fails** (e.g. the `503 Wiki registry unavailable` the endpoint already returns): select is disabled, an inline destructive-text message is shown, and the submit button is disabled — the user cannot create a workspace or project until this is resolved (deliberately hard-blocking, per product decision: a broken wiki registry should surface immediately rather than silently degrade).
- **Domains fetch succeeds with an empty list**: select shows only "None" — not an error state.
- **Everything else** (invalid `wikiId`, etc.): unchanged — surfaces through the existing generic `catch { error.value = ... }` in `handleSubmit`, same as every other field today.

---

## Testing

### Unit (Jest, `ui/`)

Extend `ui/src/pages/workspaces/index.test.tsx`:

- Select defaults to "None"; after a successful fetch, lists domains by their `domain` field.
- Selecting a domain and submitting in Workspace mode calls `createWorkspace` with that domain's `id` as `wikiId`.
- Leaving "None" selected sends `wikiId: null`.
- Project mode never renders the select; shows the static ephemeral-wiki text instead; submitted payload always sends `wikiId: null`.
- `fetchDomains` rejecting → select is disabled, error text renders, submit button is disabled, and submitting the form does not call `createWorkspace`/`createProject`.

### E2E

No new Playwright coverage — this is a form-wiring change over an already-tested creation flow (`e2e/tests/workspace-project.spec.ts`), consistent with how the Git-config and dependency-isolation designs scoped their coverage (Jest-only for pure form wiring, e2e only where a change touches real subprocesses/filesystem behavior).
