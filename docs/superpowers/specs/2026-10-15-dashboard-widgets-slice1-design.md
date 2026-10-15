# Dashboard Widget System — Vertical Slice 1: Basic Widget Rendering — Design

**Date:** 2026-10-15
**Status:** Draft
**Related:** [Issue #177](https://github.com/tkottke90/amazing-hashbrown/issues/177) (this slice), [Issue #176](https://github.com/tkottke90/amazing-hashbrown/issues/176) (overall vision), [Issue #178](https://github.com/tkottke90/amazing-hashbrown/issues/178) (Slice 2: persistence), [Issue #179](https://github.com/tkottke90/amazing-hashbrown/issues/179) (Slice 3: edit mode)

---

## Goal

Render a dashboard of static Markdown widgets in a responsive grid, make it the app's landing page, and shape the widget type system so Slices 2–3 (persistence, edit mode, more widget types) extend it without rework. No persistence, no editing, no drag/resize in this slice — those are later issues.

---

## Problem

Today `/` immediately redirects to the active chat thread (`RootRedirect` in `ui/src/app.tsx`) — there is no landing surface for anything other than chat. Issue #176 wants the main page to become an information hub with multiple widget types (markdown now; big-number, line-graph, pie-graph later), persisted layout, and drag/resize editing. Building straight at that scope in one PR is too much to review and verify at once; this slice carries only the rendering foundation — but the foundation has to be shaped correctly, because three more slices build directly on top of whatever types and file layout this one sets down.

---

## Decisions (and why)

| #   | Decision                                                                                                                                        | Rationale                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `/` renders the new `DashboardView` directly; `RootRedirect` is deleted.                                                                        | Matches issue #177/#176's explicit "dashboard is the main landing page." Chat is unaffected — `/chat/:id` is still reachable via the sidebar thread list and "New conversation."                             |
| D2  | A new "Dashboard" link is added to `thread-sidebar.tsx`, above Inbox, routed to `/`.                                                            | Once `/` stops auto-redirecting to chat, there must be a way back to it from any other page, consistent with how Inbox/Workspaces/Threads/Wiki/Settings are already reached.                                |
| D3  | `DashboardWidget` is a discriminated union on a `type` field, with exactly one member (`MarkdownWidget`) in this slice.                         | Issue #176 names 3 more widget types. Starting the union now — even with one member — means adding a type later is "add a sibling interface + a switch case," not a rewrite. Matches `AGENTS.md`'s composition-over-customization principle (no generic `content: any` bag). |
| D4  | Every widget interface must `extends WidgetBase`, which declares `type: string` as a required field.                                            | Forgetting to declare `type` on a new widget interface becomes a compile error ("Property 'type' is missing") rather than a silent gap — this is the type-level guard the union's discriminant depends on. |
| D5  | `widget-renderer.tsx` dispatches on `widget.type` via a `switch` whose `default` branch calls an `assertNever` helper.                          | If a new variant is added to `DashboardWidget` without a corresponding `case`, the `default` branch no longer type-checks as `never` — a compile error, not a runtime gap. Covered by a runtime test too (cast an invalid `type` through `unknown`). |
| D6  | Widget data comes from a `useDashboardWidgets()` hook returning a static, hardcoded array. No fetch, no file I/O.                               | Matches the issue's explicit "no persistence yet." The hook is the seam: Slice 2 changes its internals to fetch/load from disk; nothing in `WidgetRenderer`/`WidgetCard`/the grid changes.                   |
| D7  | Layout is plain Tailwind CSS Grid (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`), no grid/drag library.                                           | The issue's own dev notes call for plain CSS Grid this slice; pulling in a drag/resize library (e.g. `react-grid-layout`) before Slice 3 needs it is premature (YAGNI) per `AGENTS.md`.                        |
| D8  | All new widget files live under `ui/src/pages/dashboard/`, not `ui/src/components/`.                                                             | Per `ui/AGENTS.md`'s placement rule: a component used by only one page belongs in that page's folder. Nothing here is reused outside the dashboard page yet.                                                 |
| D9  | Markdown widget content renders through the existing `Markdown` component (`ui/src/components/markdown.tsx`).                                   | Reuses the already-sanitized/styled renderer (remark-gfm, rehype-highlight, artifact-image/link overrides) instead of adding a second markdown pipeline.                                                     |

---

## 1. Data model (`ui/src/pages/dashboard/types.ts`)

```ts
interface WidgetBase {
  id: string;
  type: string; // discriminant; narrowed to a literal by each concrete variant
  title: string;
  subtitle?: string;
}

export interface MarkdownWidget extends WidgetBase {
  type: 'markdown';
  content: string; // markdown source
}

export type DashboardWidget = MarkdownWidget;
// Future slices add: | BigNumberWidget | LineGraphWidget | PieGraphWidget
```

**Why `WidgetBase` + `extends`, not just a union of unrelated interfaces:** if a future widget interface extends `WidgetBase` but omits `type`, TypeScript rejects the declaration ("Property 'type' is missing") at the point it's written — before it ever reaches the union or the renderer. `id` exists now (not in the issue's sample data) because Slice 2's persistence and add/remove flows need identity, and `.map()` deserves a real key over array index now rather than a later migration.

## 2. Widget components (`ui/src/pages/dashboard/`)

- **`widget-card.tsx`** — shared presentational shell: bordered card (`rounded-md border border-border bg-card`, matching `ThreadCardShell`'s visual language), renders `title`, optional `subtitle`, and a children slot for the type-specific content. Every widget type composes this; it has no knowledge of widget types.
- **`markdown-widget.tsx`** — renders a `MarkdownWidget`'s `content` through `<Markdown>`.
- **`widget-renderer.tsx`** — the dispatch point:

  ```ts
  function assertNever(x: never): never {
    throw new Error(`Unhandled widget type: ${(x as DashboardWidget).type}`);
  }

  export function WidgetRenderer({ widget }: { widget: DashboardWidget }) {
    switch (widget.type) {
      case 'markdown':
        return <MarkdownWidget widget={widget} />;
      default:
        return assertNever(widget);
    }
  }
  ```

  Adding `big-number` to the union without adding a `case 'big-number'` here fails to compile, because `widget` in the `default` branch is no longer narrowed to `never`.

- **`use-dashboard-widgets.ts`** — hook returning a static array of 3–4 sample `MarkdownWidget`s (more than one, so the grid has something to actually reflow across breakpoints). This is the only file Slice 2 needs to change to switch from static data to a real load.

## 3. Dashboard page & grid

- **`dashboard-grid.tsx`** — the responsive grid:

  ```tsx
  <div class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
    {widgets.map((w) => (
      <WidgetRenderer key={w.id} widget={w} />
    ))}
  </div>
  ```

  1 column by default, 2 at `sm:` (≥640px), 3 at `lg:` (≥1024px) — this repo's existing Tailwind breakpoints. No explicit row sizing: each card's height follows its content, so resizing the grid changes column count and row count flows naturally, with no overlap or clipping.

- **`index.tsx`** (`DashboardView`) — follows the same page shell as `ThreadsView`/`SettingsView`:

  ```tsx
  export function DashboardView(_props: { path?: string }) {
    useTitle('Dashboard');
    const widgets = useDashboardWidgets();
    return (
      <Layout>
        <div class="flex flex-col h-full overflow-y-auto">
          <div class="px-6 pt-6 pb-4">
            <h1 class="text-xl font-semibold">Dashboard</h1>
          </div>
          <DashboardGrid widgets={widgets} />
        </div>
      </Layout>
    );
  }
  ```

  `<Layout>` with no `aside` override renders the default `ThreadSidebar`, so the dashboard gets the same nav as every other top-level page for free.

## 4. Routing & navigation

- `ui/src/app.tsx`: delete the `RootRedirect` function and its `<RootRedirect path="/" />` registration; register `<DashboardView path="/" />` in its place. `<ChatRoot path="/chat/:id" />` is untouched.
- `ui/src/components/thread-sidebar.tsx`: add a "Dashboard" link (icon: `LayoutDashboard` from `lucide-preact`) above the Inbox link, following the exact existing pattern (`guardAnchorClick`, active-state class when `url === '/'`).

## 5. Testing

Per `ui/AGENTS.md`, Jest tests live flat under `ui/test/`, named after the source file, tagged `[unit]`/`[orchestration]`.

**Jest:**
- `dashboard-widget-card.test.tsx` [unit] — renders title/subtitle/children; subtitle omitted when absent.
- `dashboard-markdown-widget.test.tsx` [unit] — renders `content` through `Markdown` (fixture with a heading renders as `<h1>`).
- `dashboard-widget-renderer.test.tsx` [unit] — dispatches `markdown` to `MarkdownWidget`; a cast-through-`unknown` invalid `type` triggers `assertNever`'s thrown error (runtime coverage of the exhaustiveness guard, alongside its compile-time guarantee).
- `use-dashboard-widgets.test.ts` [unit] — returns a deterministic, non-empty array of valid `DashboardWidget`s.
- `dashboard-view.test.tsx` [orchestration] — renders one `WidgetRenderer` per item `useDashboardWidgets()` returns (composition check, not re-testing card internals).
- `thread-sidebar.test.tsx` — extend with a case: Dashboard link renders, points at `/`, gets active-state class when `url === '/'`.

**Playwright (`e2e/tests/`):**
- `@smoke` — load `/`, assert the dashboard renders with at least one markdown widget showing title, subtitle, and rendered markdown content.
- `@user-workflow` — from another page (e.g. Wiki), click the sidebar Dashboard link, land on `/`, widgets visible.
- Viewport/responsive check (`@smoke` or `@functional`) — resize across mobile/tablet/desktop widths, assert column count changes and no clipping/overlap.

## 6. Out of scope (future slices)

- Persistence to disk (frontmatter/manifest) — Issue #178.
- Edit mode, resize handles, drag-and-drop — Issue #179.
- `big-number`, `line-graph`, `pie-graph` widget types — Issue #176.
- Real-time updates from System/Agents/Automations — Issue #176.
