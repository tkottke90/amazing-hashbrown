# Dashboard Widget System — Vertical Slice 2: Widget Persistence — Design

**Date:** 2026-10-16
**Status:** Draft
**Related:** [Issue #178](https://github.com/tkottke90/amazing-hashbrown/issues/178) (this slice), [Issue #176](https://github.com/tkottke90/amazing-hashbrown/issues/176) (overall vision), [Issue #177](https://github.com/tkottke90/amazing-hashbrown/issues/177) (Slice 1, merged), [Issue #179](https://github.com/tkottke90/amazing-hashbrown/issues/179) (Slice 3: edit mode)

---

## Goal

Replace Slice 1's hardcoded widget array with real disk persistence: load on
dashboard init, save on create/edit/delete, survive reload. Markdown widget
content can be added, edited, and removed from the UI. Lay the storage/API
groundwork for the parent issue's stated multi-dashboard future, without
building any multi-dashboard UI in this slice.

## Problem

Issue #178's own requirements contradict each other: "Dashboard Interface"
says "(No editing capabilities yet)," but its Acceptance Criteria require
add/edit/remove of Markdown widgets. Resolution: "no editing" refers to
_layout_ editing (drag/resize/reposition) — that is Slice 3's explicit job
(issue #179, "Edit Mode Foundation"). Content CRUD for Markdown widgets is
this slice's job, or the acceptance criteria are unmet by construction.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A new workspace package `lib/amazing-hashbrown-widgets` (`@tkottke90/amazing-hashbrown-widgets`) owns the widget types and all persistence logic.                                                                                                                                                          | Same pattern this repo already uses for `lib/llm-wiki`: a library the API imports to do the actual work, and the UI imports (a types-only subpath of) for its type definitions — one definition, not two kept in sync by hand.                                                                                                                                                          |
| D2  | Each widget persists as its own Markdown file with YAML frontmatter (`gray-matter`, already a dependency), not a single manifest file.                                                                                                                                                                     | Matches issue #176's own stated storage strategy ("stored as markdown files... frontmatter"); avoids one file being rewritten on every single-widget edit; mirrors the wiki's already-proven file-per-page pattern.                                                                                                                                                                     |
| D3  | Storage is one subfolder per dashboard under a new `dashboardRoot` config value, each containing one `<slug>.md` per widget: `dashboard/default/welcome.md`.                                                                                                                                               | Endorses the parent issue's actual goal (multiple dashboards) in the data layout now, so a later slice adding dashboard CRUD doesn't need a storage migration — without building any dashboard-management UI this slice.                                                                                                                                                                |
| D4  | Only one dashboard exists this slice: `{ id: 'default', name: 'Dashboard' }`, hardcoded in code. No dashboard metadata file on disk.                                                                                                                                                                       | A metadata file describing one record with one field worth varying is exactly the premature structure AGENTS.md's YAGNI principle warns against. Add it when a slice actually needs to create/rename/list dashboards.                                                                                                                                                                   |
| D5  | A widget's filename is generated once at creation time from a slugified title and never renamed on a later title edit. On a slug collision, append the first 8 hex characters of a fresh `randomUUID()` (e.g. `tip-a3f09c21.md`).                                                                          | Keeps the widget's identity (used in API routes) stable across edits — renaming the file on every title edit would churn the id/URL for no functional benefit and risk a fresh collision on every rename, not just creation. The UUID suffix is simpler and more collision-proof than a tracked incrementing index.                                                                     |
| D6  | The widget's `id` is its filename without extension — unique within its dashboard folder, and never duplicated inside its own frontmatter. Every API route that takes an `id` is already scoped by `:dashboardId`, so `id` itself carries no dashboard prefix (no `/`-in-a-path-segment encoding problem). | One source of truth for identity; nothing to keep in sync between the filename and an internal field, and no ambiguity about what a bare `id` means once it's out of its dashboard-scoped context.                                                                                                                                                                                      |
| D7  | `WidgetBase` gains `order: number` (every widget type needs it to render in a stable sequence); no `position`/size field is added yet.                                                                                                                                                                     | `order` is this slice's own requirement. `position`/size is Slice 3/4's concern (resize, drag-persisted layout) — adding it now means a field nothing reads or writes until then, which is exactly what YAGNI argues against.                                                                                                                                                           |
| D8  | The widget-list API response is a list of per-item results: `{status:'ok', widget: DashboardWidget}` or `{status:'error', id, raw, error}`. A file that fails to parse is surfaced, not silently dropped or hard-failed.                                                                                   | Keeps `DashboardWidget` a clean, type-only discriminated union (per Slice 1's own stated principle) instead of smuggling a load-failure state into it — a parse failure isn't a widget type, it's a wrapper that can happen to any file. Mirrors the "one bad entry doesn't poison the whole list" philosophy already used for `providers`/`favoriteModels` in `api/src/config/env.ts`. |
| D9  | A broken widget renders as an "Unable to load this widget" card with an "Edit raw file" action, which opens the widget Drawer in a raw-text mode (one `Textarea`, the entire file content including frontmatter delimiters) and saves unconditionally via `PUT .../widgets/:id/raw` — no validation gate.  | Gives the user a concrete remediation path (per the issue's own "error handling for corrupt files" testing consideration) without designing a partial-validation UX: a still-broken save just shows the same error card again on the next load, and the user keeps iterating.                                                                                                           |
| D10 | Widget creation/editing via the API is restricted to `type: 'markdown'`. Other types are out of scope for write operations entirely, not just "optional to persist."                                                                                                                                       | Matches "(Other widget types can be displayed but not required for this slice)." There's no UI or API surface to build for types that have no second union member yet.                                                                                                                                                                                                                  |
| D11 | Add/Edit UI uses the existing `Drawer` component (`@tkottke90/preact-dialog`), following the exact `mode: 'add' \| 'edit'` / `trigger` shape already used by `mcp-server-drawer.tsx`. Delete uses a plain `window.confirm(...)`, matching `mcp-servers-panel.tsx`.                                         | Zero new UI mechanisms — both patterns already exist and are used for equivalent CRUD-over-a-settings-style-list flows elsewhere in this app.                                                                                                                                                                                                                                           |
| D12 | Every mutation (create/update/delete) calls the API, then refetches the full widget list — no optimistic local update — showing a toast on failure.                                                                                                                                                        | Matches `mcp-servers-panel.tsx`'s `await mutate(); await refresh();` pattern. Simpler and lower-risk than building optimistic-update/rollback logic for a slice that isn't asking for it.                                                                                                                                                                                               |
| D13 | Edit/delete controls live on the Markdown-specific widget component, not threaded into the shared, type-agnostic `widget-card.tsx` shell.                                                                                                                                                                  | Preserves the boundary Slice 1's design deliberately drew ("[the shell] has no knowledge of widget types"). A future widget type that's never editable costs nothing.                                                                                                                                                                                                                   |
| D14 | `useDashboardWidgets()` does a plain `fetch` on mount — no SSE, no real-time push.                                                                                                                                                                                                                         | Real-time updates from System/Agents/Automations are explicitly future scope under issue #176, a different and much larger piece of work.                                                                                                                                                                                                                                               |
| D15 | `dashboardRoot` is added to `AppConfigSchema`/`env` exactly like `wikiRoot`/`artifactRoot`/`skillsRoot`/`projectsRoot` (default `'./dashboard'`, resolved via `configManager.getConfigDir()`), with no corresponding Settings-page UI field this slice.                                                    | Reuses an established mechanism; a config.yaml-only knob is enough since no acceptance criterion asks for a UI to relocate it.                                                                                                                                                                                                                                                          |

---

## 1. `lib/amazing-hashbrown-widgets`

Mirrors `lib/llm-wiki`'s shape (`package.json` with `main`/`types`/`exports`,
`tsc` build, Mocha+Chai tests):

```
lib/amazing-hashbrown-widgets/
  package.json          # name: "@tkottke90/amazing-hashbrown-widgets"
  src/
    index.ts            # re-exports store + types
    types.ts            # WidgetBase, MarkdownWidget, DashboardWidget, Dashboard
    internal/
      frontmatter.ts     # parse/serialize via gray-matter (same shape as llm-wiki's)
      slug.ts            # slugify + collision suffix
    store.ts             # listWidgets, createWidget, updateWidget, updateWidgetRaw, deleteWidget
```

`package.json` `exports`:

```json
{
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./types": { "types": "./dist/types.d.ts", "default": "./dist/types.js" }
}
```

`ui/` depends on `@tkottke90/amazing-hashbrown-widgets` and imports only from
`@tkottke90/amazing-hashbrown-widgets/types` — no `node:fs`/`gray-matter` in
the browser bundle. `api/` depends on the whole package.

### 1.1 Types (`src/types.ts`)

```ts
export interface WidgetBase {
  id: string; // the widget's filename, without extension — unique within its
  // dashboard folder and derived from it, never duplicated in frontmatter.
  // Every route that takes an id is already scoped by :dashboardId, so id
  // itself carries no dashboard prefix.
  type: string;
  title: string;
  subtitle?: string;
  order: number;
}

export interface MarkdownWidget extends WidgetBase {
  type: 'markdown';
  content: string;
}

export type DashboardWidget = MarkdownWidget;
// Future slices add: | BigNumberWidget | LineGraphWidget | PieGraphWidget

export interface Dashboard {
  id: string;
  name: string;
}

export type WidgetLoadResult =
  | { status: 'ok'; widget: DashboardWidget }
  | { status: 'error'; id: string; raw: string; error: string };
```

`ui/src/pages/dashboard/types.ts` is deleted; every current import of
`DashboardWidget`/`MarkdownWidget` (`widget-renderer.tsx`,
`use-dashboard-widgets.ts`, `markdown-widget.tsx`, their tests) switches to
`@tkottke90/amazing-hashbrown-widgets/types`.

### 1.2 Store (`src/store.ts`)

- `listWidgets(dashboardRoot, dashboardId): Promise<WidgetLoadResult[]>` —
  reads every `*.md` in `<dashboardRoot>/<dashboardId>/`, parses frontmatter,
  validates against a Zod schema for `MarkdownWidget`'s frontmatter fields
  (`title`, `subtitle?`, `type`, `order`); a file that fails to read or
  validate becomes a `{status:'error', id, raw, error}` entry carrying the
  raw file text. Sorted: all `ok` entries by `order` ascending, then all
  `error` entries (their `order`, if present at all, isn't trustworthy)
  appended at the end.
- `createWidget(dashboardRoot, dashboardId, {title, subtitle, content})` —
  slugifies `title`, resolves a collision by appending an 8-hex-char
  `randomUUID()` slice, assigns `order = max(existing) + 1`, writes the file,
  returns the new `MarkdownWidget`.
- `updateWidget(dashboardRoot, dashboardId, id, {title, subtitle, content})`
  — rewrites the existing file's frontmatter/body in place; filename is
  unchanged regardless of a title change. Backs the `PATCH` endpoint below.
- `updateWidgetRaw(dashboardRoot, dashboardId, id, raw: string)` — writes
  `raw` to the file verbatim. No parse/validate step — the next `listWidgets`
  call is what tells the caller whether it's fixed. Backs the `PUT .../raw`
  endpoint below, the same "`PUT` replaces a file's whole raw content"
  convention `skills.route.ts`'s `PUT /:name/files/:dir/:basename` already
  uses in this codebase.
- `deleteWidget(dashboardRoot, dashboardId, id)` — removes the file.
- `ensureSeeded(dashboardRoot, dashboardId)` — if the dashboard's subfolder
  doesn't exist or is empty, create it and write Slice 1's 4 sample widgets
  as real files (same titles/subtitles/content as today's
  `use-dashboard-widgets.ts` constants), each with sequential `order`.
  Called once at server boot for the `default` dashboard.

---

## 2. Storage layout

```
dashboard/                  # dashboardRoot, default './dashboard'
  default/                  # dashboardId — only one exists this slice
    welcome.md
    getting-started.md
    tip.md
    changelog.md
```

Each file:

```md
---
title: Welcome
subtitle: Your AI Workspace
type: markdown
order: 0
---

# Welcome to Amazing Hashbrown

This is your central dashboard for all AI-powered features.
```

`dashboardRoot` is added to `api/src/config/env.ts`'s `AppConfigSchema`
(`dashboardRoot: z.string().default('./dashboard')`) and `env` getter
(`configManager.getConfigDir(configManager.get('dashboardRoot'))`) — the
same pattern as `wikiRoot`/`artifactRoot`/`skillsRoot`/`projectsRoot`. No
Settings-page field for it this slice.

### Why subfolders, not a flat `<dashboardId>-<slug>.md` naming

A flat single directory with a dashboard-id prefix was the first-pass
proposal, but a real subfolder per dashboard is the better fit for the
parent issue's actual goal (multiple dashboards): it keeps each dashboard's
files physically grouped, needs no prefix-parsing to recover `dashboardId`
from a filename, and means a future "duplicate this dashboard" or "delete
this dashboard" operation is a directory operation instead of a filtered
bulk-file operation.

---

## 3. API (`api/src/routes/v1/dashboards.route.ts` + `dashboards.handlers.ts`)

Thin-route/testable-handler split, per `api/AGENTS.md`'s established
`*.handlers.ts` convention — handlers take plain typed arguments and return
`HandlerResult<T>`, routes map that onto the HTTP response. `:dashboardId`
is accepted in every route for forward-compatibility, but the UI only ever
calls it with `'default'` this slice. Methods follow this codebase's
existing split: `PATCH` for a structured field update (same as
`workspaces.route.ts`, `tasks.route.ts`, `mcp-servers.route.ts`, …), `PUT`
for an unconditional whole-file raw overwrite (same as `skills.route.ts`'s
`PUT /:name/files/:dir/:basename`).

| Method | Path                                              | Body                          | Notes                                       |
| ------ | ------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| GET    | `/api/v1/dashboards/:dashboardId/widgets`         | —                             | Returns `WidgetLoadResult[]`                |
| POST   | `/api/v1/dashboards/:dashboardId/widgets`         | `{title, subtitle?, content}` | Always creates `type: 'markdown'`           |
| PATCH  | `/api/v1/dashboards/:dashboardId/widgets/:id`     | `{title, subtitle?, content}` | 404 if `:id` doesn't resolve to a file      |
| PUT    | `/api/v1/dashboards/:dashboardId/widgets/:id/raw` | `{raw: string}`               | Unconditional overwrite, for error recovery |
| DELETE | `/api/v1/dashboards/:dashboardId/widgets/:id`     | —                             | 404 if `:id` doesn't resolve to a file      |

`app.ts`'s server boot calls `ensureSeeded(env.dashboardRoot, 'default')`
once before `app.listen`, alongside existing startup work.

---

## 4. UI

### 4.1 Data fetching

`use-dashboard-widgets.ts` becomes a hook with `widgets: WidgetLoadResult[]`,
`loading`, `error` signals, doing a plain `fetch('/api/v1/dashboards/default/widgets')`
on mount — no SSE. A new `services/dashboard-api.ts` holds the
`fetch`/`create`/`update`/`updateRaw`/`delete` calls, following the shape of
`services/mcp-servers-api.ts`.

### 4.2 Rendering

- `widget-renderer.tsx`'s switch now also handles `WidgetLoadResult`: an
  `error` item renders a new `widget-error-card.tsx` (reuses `widget-card.tsx`'s
  shell with a fixed "Unable to load this widget" title and the error text as
  subtitle-equivalent body), with an "Edit raw file" button.
- `markdown-widget.tsx` gains the edit/delete affordances (small icon buttons
  in the card header) — not `widget-card.tsx`, per D13.

### 4.3 Add / Edit / Delete

- New `widget-drawer.tsx`: `Drawer` from `@tkottke90/preact-dialog`,
  `mode: 'add' | 'edit' | 'raw'`, same `trigger`-prop shape as
  `mcp-server-drawer.tsx`. `'add'`/`'edit'` render title/subtitle/content
  fields (`Input`/`Input`/`Textarea`, no type selector, no live preview);
  `'raw'` renders a single `Textarea` bound to the file's full raw content.
- An "Add widget" button (`data-testid="dashboard-add-widget"`) sits in the
  dashboard header (`index.tsx`), opening the Drawer in `'add'` mode.
- Delete: a trash icon (`data-testid="widget-delete-button"`) on each
  Markdown widget card calls
  `window.confirm('Remove widget "<title>"? This cannot be undone.')`,
  matching `mcp-servers-panel.tsx`'s copy pattern.
- Every action: call the API, `await refresh()` the list, `showToast('error', ...)`
  on failure. No optimistic updates.

### 4.4 Test IDs

New `data-testid`s (to be recorded in `e2e/AGENTS.md`'s table per its own
instructions, same as Slice 1 added `dashboard-grid`/`widget-card`):

| `data-testid`            | Element                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dashboard-add-widget`   | Header "Add widget" button, opens the Drawer in `add` mode                                                                                                   |
| `widget-edit-button`     | Markdown widget card's edit (pencil) icon                                                                                                                    |
| `widget-delete-button`   | Markdown widget card's delete (trash) icon                                                                                                                   |
| `widget-error-card`      | An error-state card (reuses `widget-card.tsx`'s shell; `widget-card` testid still applies too — this one is additive, for tests that need to distinguish it) |
| `widget-edit-raw-button` | Error card's "Edit raw file" action                                                                                                                          |
| `widget-drawer-form`     | The Drawer's form element, any mode                                                                                                                          |

---

## 5. Testing

Per root `AGENTS.md` and `api`/`ui` `AGENTS.md`:

**`lib/amazing-hashbrown-widgets` (Mocha + Chai):**

- `internal/frontmatter.test.ts` [unit] — parse/serialize round-trips; parse
  of malformed YAML throws a catchable error.
- `internal/slug.test.ts` [unit] — slugifies a title; a second call with a
  colliding slug returns a different, UUID-suffixed value.
- `store.test.ts` [unit] — `createWidget`/`updateWidget`/`deleteWidget`
  against a temp directory; `listWidgets` returns `ok` entries sorted by
  `order` and `error` entries (seeded with a hand-written malformed file)
  appended last; `updateWidgetRaw` writes verbatim with no validation;
  `ensureSeeded` is a no-op on a non-empty folder and populates 4 widgets on
  an empty/missing one.

**`api/` (Mocha + Chai):**

- `routes/v1/dashboards.handlers.test.ts` [unit] — each handler against a
  stubbed store module: 200/201/404 paths, markdown-only enforcement on
  create, the `PUT .../raw` handler bypasses validation.

**`ui/` (Jest):**

- `dashboard-widget-renderer.test.tsx` [unit] — extend for `WidgetLoadResult`:
  an `error` item renders the error card.
- `dashboard-widget-error-card.test.tsx` [unit] — renders the error message
  and an "Edit raw file" trigger.
- `dashboard-markdown-widget.test.tsx` [unit] — extend with edit/delete
  button presence and their callbacks.
- `widget-drawer.test.tsx` [unit] — add/edit/raw modes render the right
  fields; submit calls the right service function.
- `use-dashboard-widgets.test.ts` [unit] — fetch success/error/loading
  states (mocked `fetch`).
- `dashboard-view.test.tsx` [orchestration] — Add button wiring, refetch
  after a mutation.

**Playwright (`e2e/tests/dashboard.spec.ts`, extend):**

- `@user-workflow` — add a Markdown widget, reload the page, confirm it's
  still there with its content, delete it, reload, confirm it's gone. Runs
  against the real (already-running) backend, no `page.route()` mocking —
  this is a deterministic file write/read, not an LLM-dependent or
  hard-to-reach state. Cleans up any widget it creates, even on failure.
- `@functional` or `@smoke` — seed a malformed widget file directly on disk
  before load (test setup, not through the UI), confirm the error card
  renders, fix it via "Edit raw file," reload, confirm it now renders
  normally.

---

## 6. Out of scope (future slices/issues)

- Dashboard create/rename/list/switch UI and API (multiple dashboards are
  structurally possible now; nothing lets a user make a second one yet).
- Drag/resize, position persistence — Issue #179 (Slice 3) and beyond.
- `big-number`, `line-graph`, `pie-graph` widget types — Issue #176.
- Real-time updates from System/Agents/Automations — Issue #176.
- Settings-page UI for `dashboardRoot`.
