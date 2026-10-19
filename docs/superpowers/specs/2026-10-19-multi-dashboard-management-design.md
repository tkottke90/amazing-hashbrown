# Multi-Dashboard Management UI — Design

**Date:** 2026-10-19
**Status:** Draft
**Related:** [Issue #316](https://github.com/tkottke90/amazing-hashbrown/issues/316) (this issue), [Issue #176](https://github.com/tkottke90/amazing-hashbrown/issues/176) (overall vision), [Issue #178](https://github.com/tkottke90/amazing-hashbrown/issues/178) / PR #310 (per-dashboard storage layout this builds on), [Issue #338](https://github.com/tkottke90/amazing-hashbrown/issues/338) (per-dashboard timeframe preset, split out of this design), [Issue #339](https://github.com/tkottke90/amazing-hashbrown/issues/339) (agent/CLI dashboard & widget targeting plus a copy-targeting-info affordance, split out of this design). Terminology used throughout (**Dashboard**, **Dashboard Id**, **Dashboard Name**, **Dashboard Metadata**, **Density**, Widget, Widget Frontmatter, Edit Mode) is defined in [`GLOSSARY.md`](../../../GLOSSARY.md). [ADR-0016](../../adr/0016-dashboard-id-permanent-decoupled-from-name.md), [ADR-0017](../../adr/0017-migrated-default-dashboard-keeps-its-id.md), and [ADR-0018](../../adr/0018-dashboard-metadata-per-folder-file.md) record the decisions below that are hard to reverse.

---

## Goal

Let a user create, switch between, rename, and delete Dashboards from the UI — each with independent Widgets/layout and its own Dashboard Name, description, and Density — replacing the single hardcoded `default` Dashboard with a real, user-manageable set.

## Problem

Today a Dashboard is just the existence of a folder: `lib/amazing-hashbrown-widgets/src/types.ts`'s `Dashboard` interface (`id`, `name`) is never constructed or returned by any handler, and the literal id `'default'` is hardcoded at the API boot sequence, in the agent tool's fallback, and in the UI's `DEFAULT_DASHBOARD_ID` constant. There is no dashboard-level API (list/create/rename/delete), no Dashboard Metadata storage, and no UI for any of this — the per-dashboard storage layout #178/#310 already built is unreachable from the product.

---

## Decisions (and why)

| #   | Decision | Rationale |
| --- | --- | --- |
| D1  | Ship create, switch, rename, delete, independent per-dashboard widgets/layout, a Settings panel (name/description/Density), and the delete-guard — in this one issue/PR. | Milestone v1.10.0 is "Dashboards"; already written into #316's Expected Behavior. |
| D2  | Per-dashboard timeframe preset is split out to #338; "Reset layout" is dropped entirely, with no follow-up issue. | Both are net-new plumbing with nothing existing to extend (see Discovery below); reset-layout specifically has no "default layout" concept anywhere server-side to revert to. |
| D3  | The existing `default` Dashboard is migrated in place, keeping its literal Dashboard Id `default`; only its Dashboard Name becomes "Default". No special protection afterward — renameable/deletable like any other once a second Dashboard exists. | [ADR-0017](../../adr/0017-migrated-default-dashboard-keeps-its-id.md). |
| D4  | Dashboard Id is permanent and decoupled from Dashboard Name. New Dashboard ids are nanoid-generated, not slugged from the name. | [ADR-0016](../../adr/0016-dashboard-id-permanent-decoupled-from-name.md). |
| D5  | Dashboard Names are not required to be unique. | Single-user app; enforcing uniqueness adds validation surface for no real benefit — identity is carried by Dashboard Id. |
| D6  | Dashboard Metadata (name, description, Density) persists in a small per-dashboard-folder file, not a central index. | [ADR-0018](../../adr/0018-dashboard-metadata-per-folder-file.md). |
| D7  | New API surface: `GET /api/v1/dashboards` (list), `POST /api/v1/dashboards` (create), `PATCH /api/v1/dashboards/:id` (update name/description/Density), `DELETE /api/v1/dashboards/:id`. No separate single-dashboard `GET`. | The UI always needs the full list for the tab bar; a single-item fetch has no caller. |
| D8  | Density (`'compact'` or `'roomy'`, default `'compact'`) stays in scope, unlike timeframe. | Needs no data-fetch plumbing — just a stored value driving the grid's existing row-height constant. |
| D9  | A newly created Dashboard starts completely empty (no seeded widgets) and shows an explicit empty-state message. | The 4-widget welcome seed `default` got at boot is a first-run-experience thing, not something to repeat on every deliberately-created Dashboard. |
| D10 | Creating a Dashboard doesn't prompt for a name upfront — it's created immediately as "Dashboard N", opens straight into Edit Mode with the widget-add picker open. Renaming only happens via the Settings panel's Name field; no inline tab rename. | Matches the design mockup's actually-wired behavior (it defines an unused `renameDashboard` handler but never attaches it to the tab UI) and avoids a second "name this thing" interaction pattern just for creation. |
| D11 | Deleting a Dashboard uses a native `confirm()` dialog. The delete control is hidden (not disabled) when only one Dashboard remains. | Matches this codebase's existing destructive-action convention exactly (e.g. `ui/src/pages/settings/skill-details-tab.tsx:44`, `ui/src/pages/dashboard/markdown-widget.tsx:41`) — the design mockup deletes with no confirmation at all, which isn't acceptable for real persisted widget data. |
| D12 | Deleting the active Dashboard switches the active Dashboard to the first remaining one in list order. | Simplest rule; no view-history tracking needed for this edge case. |
| D13 | The last-active Dashboard id is remembered in `localStorage` and restored on load; first-ever load (nothing stored, or the stored id no longer exists) falls back to the first Dashboard in list order. | Expected behavior for a tabbed UI; no server-side session concept to hang this off instead. |
| D14 | The Dashboard Settings panel is reachable from view mode, not gated behind Edit Mode. | Renaming/describing a Dashboard is a metadata action, not a layout edit — gating it behind "Edit layout" (what the mockup does) reads as a mockup shortcut, not a deliberate UX choice. |
| D15 | Agent/CLI tools keep defaulting `dashboardId` to `'default'`, unmodified, in this issue. | Teaching agents to target an arbitrary Dashboard/Widget is its own judgment-heavy problem — split out to #339. |

---

## Discovery (facts this design is built on)

- **Hardcoded `'default'` call sites**: `api/src/index.ts:20,78` (boot seed), `api/src/agents/tools/update-widget-content.tool.ts:14,47` (agent tool fallback — unchanged by D15), `ui/src/services/dashboard-api.ts:10-12` (`DEFAULT_DASHBOARD_ID`), `ui/src/hooks/use-dashboard-widgets.ts:4,86` (hook default param).
- **No dashboard-level routes exist today** — every route under `api/src/routes/v1/dashboards.route.ts` is widget-scoped (`/:dashboardId/widgets...`); a dashboard folder is only ever created as a side effect of `createWidget`'s `fs.mkdir(..., { recursive: true })`.
- **No auth/multi-tenant concept anywhere** (`api/src/services/api-key-store.ts:8-10`'s own comment: "acceptable while the app is single-user") — Dashboards are global to the instance, confirming D5.
- **`ensureSeeded(root, dashboardId)` (`store.ts:468-494`)** only ever runs for `'default'` at boot, no-ops if the folder already has widget files, and seeds 4 fixed markdown widgets — there's no reusable "default layout" template a `deleteLayout`/reset action could target, which is why D2 drops reset-layout entirely rather than inventing one.
- **`use-dashboard-widgets.ts`'s module-level signal store is already keyed by `dashboardId`**, per its own comment ("future-proofs multi-dashboard #316 for free") — the widget-loading hook needs no changes for this issue.
- **Destructive-action convention**: every existing delete flow in the UI (`skill-details-tab.tsx:44`, `notifications-panel.tsx:81`, `mcp-servers-panel.tsx:76`, `markdown-widget.tsx:41` and its sibling widget types, `workspaces/[id].tsx:228`) uses `confirm('...? This cannot be undone.')` — D11 follows this exactly rather than inventing a modal.
- **No existing density/row-height concept**: `GRID_ROW_HEIGHT_PX = 88` is a bare constant in `ui/src/pages/dashboard/grid-constants.ts:8-11` (see ADR-0010) — Density (D8) is genuinely new plumbing, just much thinner than timeframe.

---

## 1. Types (`lib/amazing-hashbrown-widgets/src/types.ts`)

```ts
export interface Dashboard {
  /** Permanent once created — see ADR-0016. */
  id: string;
  name: string;
  description?: string;
  density: 'compact' | 'roomy';
}
```

Remove the existing interface's stale "currently always the single hardcoded `default` instance" comment.

## 2. Dashboard Metadata storage (`lib/amazing-hashbrown-widgets/src/store.ts`)

A new per-folder file, e.g. `dashboardMetadataPath(root, id) = path.join(dashboardDir(root, id), 'dashboard.json')`, holding:

```json
{ "name": "Homelab", "description": "", "density": "compact" }
```

`id` isn't duplicated inside the file — the folder name is the single source of truth, the same relationship a widget's filename has to its `id`.

New store functions:

- `listDashboards(root): Promise<Dashboard[]>` — reads every subfolder of `root`; a folder with no `dashboard.json` yet (only possible pre-migration, for `default`) reads with sane defaults (`name` derived from the folder id, `description: ''`, `density: 'compact'`), the same backward-compatible read-time-default pattern Widget Size uses (ADR-0009). Sorted by folder creation order for stable list order (D12/D13's "first in list").
- `createDashboard(root, name): Promise<Dashboard>` — generates a nanoid id, creates the folder, writes `dashboard.json` with the given name and `description: ''`, `density: 'compact'`.
- `getDashboardMetadata(root, id): Promise<Dashboard | null>`.
- `updateDashboardMetadata(root, id, patch): Promise<Dashboard>` — merge-writes `name`/`description`/`density`.
- `deleteDashboard(root, id): Promise<void>` — `fs.rm(dashboardDir(root, id), { recursive: true })`. The "can't delete the last Dashboard" guard belongs to the route handler, not the store — store functions stay dumb persistence, the same division of labor the widget store already uses.

## 3. Migration (`api/src/index.ts` boot sequence)

Alongside the existing `ensureDashboardSeeded(env.dashboardRoot, 'default')` call, add a one-time, idempotent step: if `default`'s folder exists but has no `dashboard.json`, write one with `{ name: 'Default', description: '', density: 'compact' }`. Runs every boot; no-ops once the file exists (same idempotent shape `ensureSeeded` already uses for widgets).

## 4. API routes (`api/src/routes/v1/dashboards.route.ts` / `dashboards.handlers.ts`)

New dashboard-level routes, alongside the existing widget-scoped ones:

- `GET /api/v1/dashboards` → `listDashboardsHandler` → `store.listDashboards`. Each returned Dashboard includes a derived (never persisted) `path` field — the resolved absolute folder path (`path.join(env.dashboardRoot, id)`) — for the Settings panel's read-only folder display (section 7).
- `POST /api/v1/dashboards` (`{ name }`) → `createDashboardHandler` → `store.createDashboard`.
- `PATCH /api/v1/dashboards/:id` (`{ name?, description?, density? }`) → `updateDashboardHandler` → `store.updateDashboardMetadata`.
- `DELETE /api/v1/dashboards/:id` → `deleteDashboardHandler` — returns a 400 if `(await store.listDashboards(root)).length <= 1`, else calls `store.deleteDashboard`.

Input validated via new Zod schemas (`DashboardCreateInputSchema`, `DashboardUpdateInputSchema`), consistent with the existing per-type widget input schemas.

## 5. UI — services/hooks

- `ui/src/services/dashboard-api.ts`: add `listDashboards()`, `createDashboard(name)`, `updateDashboard(id, patch)`, `deleteDashboard(id)`. `DEFAULT_DASHBOARD_ID` stays as the literal `'default'` fallback (D3/D15 — nothing changes here).
- New `ui/src/hooks/use-dashboards.ts`: a signal holding `Dashboard[]` plus `activeDashboardId`, loaded via `listDashboards()` on mount. `activeDashboardId` initializes from `localStorage` (D13), falling back to the first Dashboard in the loaded list if the stored id no longer exists or nothing is stored yet. Every change persists back to `localStorage`.
- `use-dashboard-widgets.ts` needs no changes — already dashboard-scoped (Discovery above).

## 6. UI — Tab bar + create/switch/delete

- New `ui/src/pages/dashboard/dashboard-tabs.tsx`: one tab per Dashboard (Dashboard Name as label), plus a trailing "+" button (`title="New dashboard"`). Active tab gets a bottom-border treatment. No drag-to-reorder (list order is creation order, matching the mockup).
- "+" click: `createDashboard('Dashboard ' + (dashboards.length + 1))`, sets it active, enters Edit Mode with the widget-add picker open (D10).
- Tab click: sets `activeDashboardId`.
- Delete (triggered from Settings, section 7): `confirm(`Delete dashboard "${name}"? This cannot be undone.`)` (D11), then `deleteDashboard(id)`, then set `activeDashboardId` to the first remaining Dashboard (D12).

## 7. UI — Dashboard Settings panel

- New `ui/src/pages/dashboard/dashboard-settings-panel.tsx`, triggered by a "Dashboard settings" button in the dashboard header, visible regardless of Edit Mode (D14).
- Fields: Name (text input), Description (textarea), Density (segmented Compact/Roomy toggle), and a **read-only Folder field** showing the Dashboard's resolved absolute path (the `path` field from section 4) — for users who need to find the dashboard's files manually.
- Footer: Cancel / Save changes. Save calls `updateDashboard(id, { name, description, density })`.
- Delete Dashboard button lives here (not in a separate edit-mode action row like the mockup, since Settings is reachable outside Edit Mode now) — hidden when `dashboards.length <= 1` (D11).

## 8. UI — Density → grid row height

`ui/src/pages/dashboard/grid-constants.ts`'s `GRID_ROW_HEIGHT_PX` stops being used as a bare constant wherever the grid renders; the grid component picks between the existing `88` (compact) and a new, larger roomy value based on the active Dashboard's `density`. The exact roomy pixel value is an implementation detail, not a design fork.

## 9. UI — Empty state

A Dashboard with zero widgets shows an empty-state message (heading + "Enter edit mode to add widgets" body text, matching the mockup's copy) — consistent with D9's "no seeded widgets."

---

## Out of scope (tracked elsewhere)

- Per-dashboard timeframe preset — [#338](https://github.com/tkottke90/amazing-hashbrown/issues/338).
- Reset layout — dropped entirely, no follow-up (no "default layout" concept exists anywhere to revert to).
- Agent/CLI dashboard & widget targeting, and a "copy targeting info" UI affordance — [#339](https://github.com/tkottke90/amazing-hashbrown/issues/339).
