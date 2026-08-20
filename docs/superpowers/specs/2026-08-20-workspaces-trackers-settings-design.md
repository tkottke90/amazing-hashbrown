# Workspaces / Trackers Settings Design

**Date:** 2026-08-20
**Status:** Approved

## Goal

Give the tracker-adapter plugin system introduced by issue #73 a Settings surface: a **Workspaces** settings page with a **Trackers** sub-section that lists whatever tracker adapters are actually registered on the server (built-in GitHub, plus anything loaded via `TRACKER_PLUGINS`) and lets the user view and configure each one's credentials (e.g. GitHub's personal access token) inline.

This is also the first Settings page in the app with internal sub-navigation — every existing nav entry (see the 2026-08-06 Settings UI design) maps 1:1 to a single flat panel. "Trackers" is the first sub-section of "Workspaces"; the shell is built so later workspace-related settings can be added as sibling sub-sections without restructuring the page.

---

## Architecture Overview

### Backend

Two independent things live behind `/api/v1/trackers*`, and it matters that they stay separate:

- **The registry** (`GET /api/v1/trackers`) reports what's actually *running* — every `TrackerAdapter` registered at boot (the built-in GitHub adapter plus any `TRACKER_PLUGINS` packages), each with `{type, displayName, icon, canCreate, authSchema}`. This is live server state, not configuration — a plugin that fails to load, or whose token isn't set, still appears in this list (with `canCreate: false` if it lacks credentials).
- **The settings section** (`GET`/`PATCH /api/v1/settings/trackers`) is the persisted *configuration* — today, just the GitHub token, masked on read like every other secret in the settings system. It follows the existing `SLUG_MAP` pattern in `settings.handlers.ts` exactly (see `embeddings`), writing to `workspaces.tasks.trackers.github` in `config.yaml`.

The Trackers UI reads from both: the registry tells it *what rows to show*, the settings section tells it *what's currently configured* for those rows.

### Frontend

The Workspaces page is a new flat entry in `SettingsNav`'s `SettingsSlug` union (`'workspaces'`), routed the same `?section=` way as every other panel. Unlike every other panel, its content isn't one form — it's a thin shell (`workspaces-panel.tsx`) holding a local sub-nav (a signal, not URL state — there's only one sub-section today, so it isn't worth a second query param) that switches between sub-section components. `trackers-section.tsx` is the only sub-section for now.

### Data Flow

1. User navigates to `/settings?section=workspaces` → lands on the Trackers sub-section (the only one, so no extra click needed)
2. `TrackersSection` calls `GET /api/v1/trackers` (registry) to get the row list, and `useSettingsSection('trackers')` (config) to get saved values + dirty/save state
3. Clicking a row's "Configure" button opens `TrackerConfigModal`, seeded from that adapter's `authSchema` (field list) and the section's current form values for that adapter's `type` key
4. Saving the modal only updates local form state (`setField(type, values)`) — exactly like `provider-modal.tsx` — the panel stays dirty until `SaveDiscardBar`'s "Save changes" is clicked
5. "Save changes" → `PATCH /api/v1/settings/trackers` → masked-token unmask/merge → `mergeConfigYaml` writes `workspaces.tasks.trackers.<type>`
6. The GitHub row's Configure modal additionally has a **Verify** button hitting `POST /api/v1/trackers/github/verify` with the in-progress (unsaved) token — this is independent of steps 4–5, so a user can verify before saving

---

## Backend

### New Files

| File | Purpose |
| --- | --- |
| `api/src/services/tracker-adapter.ts` | `TrackerAdapter`/`TrackerItem`/`AuthField`/`CanonicalState` interface |
| `api/src/services/tracker-registry.ts` | `TrackerRegistry` class + `bootTrackerRegistry()`/`getTrackerRegistry()` singleton, `TRACKER_PLUGINS` discovery |
| `api/src/adapters/tracker-github.ts` | Built-in GitHub adapter (`resolveUrl`, `getItem`, `createItem`, `updateState`) |
| `api/src/routes/v1/trackers.route.ts` + `trackers.handlers.ts` | `GET /trackers`, `POST /trackers/github/verify`, `POST /trackers/:type/resolve`, `GET /trackers/:type/items`, `POST /trackers/:type/items` |

### Modified Files

| File | Change |
| --- | --- |
| `api/src/config/env.ts` | New `WorkspacesSchema` → `TasksConfigSchema` → `TrackersConfigSchema` → `GithubTrackerSchema` nesting, `env.workspaces` getter |
| `api/src/routes/v1/index.ts` | `v1Router.use('/trackers', trackersRouter)` |
| `api/src/routes/v1/settings.handlers.ts` | New `trackers` `SLUG_MAP` entry (masked token, writes `workspaces.tasks.trackers.github`) |
| `api/src/index.ts` | `bootTrackerRegistry()` after `bootWorkspaceStore(db)` |

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/trackers` | List registered adapters (registry, not config) |
| `POST` | `/api/v1/trackers/github/verify` | Validate a candidate token against the GitHub API, return scope-derived `canCreate` |
| `POST` | `/api/v1/trackers/:type/resolve` | Resolve a pasted URL to a `TrackerItem` preview |
| `GET` | `/api/v1/trackers/:type/items?id=` | Fetch current state for a linked item (id passed as a query param, not a path segment, since a GitHub id like `owner/repo#123` contains `/` and `#`) |
| `POST` | `/api/v1/trackers/:type/items` | Create a new item (Option B only) |
| `GET`/`PATCH` | `/api/v1/settings/trackers` | Persisted tracker config (masked token), via the generic settings-section dispatcher |

---

## Frontend

### New Files

```
ui/src/services/trackers-api.ts       # listTrackers, resolveTrackerUrl, getTrackerItem,
                                       # createTrackerItem, verifyGithubToken
ui/src/pages/settings/
  workspaces-panel.tsx                # Sub-nav shell (activeSubsection signal, default 'trackers')
  trackers-section.tsx                # Registry-driven list + Configure modal + SaveDiscardBar
  tracker-config-modal.tsx            # authSchema-driven config modal (masked fields, Verify button)
```

### Modified Files

| File | Change |
| --- | --- |
| `ui/src/pages/settings/settings-nav.tsx` | Add `'workspaces'` to `SettingsSlug`, a `NAV_ITEMS` entry |
| `ui/src/pages/settings/index.tsx` | `case 'workspaces': return <WorkspacesPanel />` |
| `ui/src/components/task-drawer.tsx` | Tracker link/create section (separate from this settings work — see the issue's task-drawer ACs) |

### Sub-navigation shape

`workspaces-panel.tsx` is deliberately minimal — no generic tab framework:

```tsx
const activeSubsection = useSignal<'trackers'>('trackers');
// ...
<div class="subnav-row">
  <button data-active={activeSubsection.value === 'trackers'}>Trackers</button>
</div>
{activeSubsection.value === 'trackers' && <TrackersSection />}
```

Adding a second sub-section later means adding one more button and one more conditional render — not restructuring the shell. See the **Settings page with sub-navigation** entry in `docs/Design/design-system.md` for when to reach for this pattern versus a flat panel.

### `TrackersSection`

Modeled directly on `model-providers-panel.tsx`:

- Row list comes from `listTrackers()` (registry), not from the settings section — a configured-but-unregistered adapter type shouldn't appear, and a registered-but-unconfigured adapter (like GitHub with no token — link-only mode) should.
- Each row: icon, `displayName`, a `canCreate`-derived badge ("Link & create" / "Link only"), and a "Configure" button (omitted for an adapter whose `authSchema` is empty — nothing to configure).
- `TrackerConfigModal` renders one field per `AuthField` (`text`/`password`/`select` → `Input`/`Input type="password"`/`Select`), using the existing "Leave blank to keep unchanged" masking convention for password fields.
- The GitHub row's modal additionally shows the Verify button and its three-state result banner (green/amber/red), copy taken verbatim from issue #73's acceptance criteria.

---

## Shared UI Patterns

Reused as-is from the existing settings system (see the 2026-08-06 design): `useSettingsSection`, `SaveDiscardBar`, `FieldError`, the masked-password + "Leave blank to keep unchanged" convention, and the `TestState` (`idle|loading|success|error`) Verify/Test-connection pattern from `embeddings-panel.tsx`.

---

## Out of Scope

- Generic per-type settings storage — the `trackers` SLUG_MAP entry is hardcoded to `github` for now; a second tracker type's config support is a small, additive follow-up, not a redesign.
- A second Workspaces sub-section — the shell supports it, but nothing else is planned yet.
- `updateState` (pushing canonical task state back to the tracker) — the adapter interface includes it, but no caller in this issue exercises it.
