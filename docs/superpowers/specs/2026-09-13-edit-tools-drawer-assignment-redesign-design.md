# Edit Tools Drawer — Assignment-Based Redesign

## Goal

Redesign the per-thread "Edit Tools" drawer (`ui/src/components/thread-tools-drawer.tsx`,
opened from the chat window's `+` menu) to group tools by **assignment status**
instead of **category**, matching a reference screenshot from another
project's agent tool-management drawer.

## Problem

Today the drawer groups rows into Built-in / MCP / Wiki / Skill-gated
sections, each rendered with its own near-identical block in
`ThreadToolsBody`. A user trying to answer "what does this thread actually
have access to right now?" has to scan four sections and mentally separate
checked from unchecked rows within each — the layout mirrors where a tool
*comes from*, not whether it's *in use*. The reference screenshot instead
answers that question directly: everything the thread cannot change sits in
one place, everything it currently has sits in another, and everything it
could add sits in a third, searchable list.

## Scope

In scope:
- Restructuring `thread-tools-drawer.tsx`'s body into three sections:
  **Built-in**, **Assigned**, **Available**.
- A search input scoped to the Available section.
- Dropping the drawer's "Reset to defaults" button.
- Minor `ThreadToolRow` changes: a per-row origin badge, and a row action
  that varies by section (none / Remove / + Add) instead of a checkbox.

Out of scope (unchanged):
- The per-thread API contract (`GET/PUT/DELETE /api/v1/threads/:id/tools`)
  and `use-thread-tools.ts`'s existing signals/actions — this is a
  presentation-layer change only.
- The Settings > Tools admin table/drawer (`tool-access-table.tsx`,
  `tool-settings-drawer.tsx`) — already redesigned in
  `2026-09-13-tool-settings-redesign-design.md`, not touched here beyond
  reusing its badge/search visual patterns for consistency.
- Any change to *what* determines whether a tool is selectable for a thread
  (global `enabled`, `alwaysOn`) — only how it's presented.

## Design

### 1. Section assignment logic

Every tool the drawer receives (`ThreadToolsResponse.tools: ThreadToolItem[]`)
sorts into exactly one of three sections, computed client-side from fields
already on `ThreadToolItem` (`alwaysOn`, `enabled`, `selected`, `category`)
— no API change:

- **Built-in** — `tool.alwaysOn === true` (wiki tools, `complete_task`) OR
  `tool.category === 'skill-gated'`. Neither sub-group is user-controllable
  here, so they share one section, but each row keeps a distinct caption:
  alwaysOn rows show "Always on", skill-gated rows show "Gated by skill".
- **Assigned** — not Built-in, and `tool.selected === true`.
- **Available** — not Built-in, `tool.selected === false`, and
  `tool.enabled === true`. A tool disabled globally (`enabled: false`) is
  filtered out of Available entirely — it cannot be added regardless, so
  listing it greyed-out would just be noise. (It's already impossible for a
  globally-disabled tool to be `selected: true`, since
  `computeThreadTools()` intersects a customized thread's snapshot with
  `getGloballyEnabledToolIds()` server-side — so this filter only ever
  affects Available, never hides something out from under an
  already-assigned row.)

Within each section, rows keep the existing implicit order from the API
response (no new sort requirement).

### 2. Row component

One `ToolRow` component replaces today's `ThreadToolRow`, parameterized by
an `action` prop instead of a bare `checked`/`onToggle` pair:

```ts
type ToolRowAction =
  | { kind: 'none'; caption: string }        // Built-in
  | { kind: 'remove'; onRemove: () => void } // Assigned
  | { kind: 'add'; onAdd: () => void };      // Available
```

Each row renders: name, description, an origin badge, and the action.
Origin badge text: `'Built-in'` when `category !== 'mcp'`, else
`` `MCP: ${mcpServer}` `` — same derivation `tool-access-table.tsx` already
uses for its Source column, copied here rather than shared, since that
module lives under `pages/settings/` and importing across that boundary
for one string isn't worth the coupling.

### 3. State & save model

Unchanged mechanism, scoped differently: a local `Set<string>` of assigned
tool ids, seeded from `selected: true` rows the same way `checkedIds` is
seeded today (the existing render-time sync against `threadToolsData`
object identity — see that code's own comment for why it's not a
`useEffect`). "+ Add" adds an id to the set; "Remove" deletes it — both
purely local state changes, no request sent. The set is committed in one
shot when the user clicks **Save**, via the existing
`saveThreadTools([...ids])` → `PUT /api/v1/threads/:id/tools` — no backend
or hook change.

**Reset to defaults is removed.** Closing the drawer without clicking Save
discards local changes, same as today. There is now no in-drawer way to
clear a thread's customization back to tracking global defaults live; that
capability can return later as its own feature if needed, but isn't part of
this redesign.

### 4. Search

One `Input` (reusing `@/components/ui/input`, same component
`tool-access-table.tsx` uses) above the Available section only, filtering
that section's rows by case-insensitive substring match against name and
description — same predicate `tool-access-table.tsx` already implements.
Built-in and Assigned are never filtered: Built-in is fixed regardless, and
Assigned is exactly what the user already has, which they'd want to see in
full while deciding what to add.

### 5. Layout

Same drawer chrome as today — `Drawer` with title "Edit Tools", same
width/slide-in classes. Body structure mirrors `tool-settings-drawer.tsx`'s
pattern exactly: an outer `flex h-full flex-col` wrapper, a `flex-1
overflow-y-auto` region holding all three sections (Built-in, then
Assigned, then Available with its search box) so **only that region
scrolls**, and a `border-t` footer *outside* the scrolling region holding
just the **Save** button — always visible regardless of scroll position,
never removed like the old two-button footer's Reset half was.

Empty states: Assigned shows "No tools assigned yet" when its list is
empty; Available shows "No matching tools" when the search query excludes
every row (and, distinctly, has no special empty state when the *unfiltered*
list is simply empty — that's the normal "everything's already assigned"
case and doesn't need a message).

## Error handling & edge cases

- **A tool becomes globally disabled while assigned.** Already handled
  upstream: `computeThreadTools()` intersects a customized thread's stored
  selection with currently-globally-enabled ids, so a newly-disabled tool
  simply stops appearing in `tools` at all (not just moved out of
  Assigned) — no special-casing needed here.
- **Saving fails.** Unchanged — `saveThreadTools()` already surfaces a
  toast on rejection and leaves `threadToolsData` (and therefore the local
  assigned set, once re-synced) unchanged, so the drawer's in-progress
  local state isn't lost on a failed save; the user can retry.
- **Empty search with no tools available at all.** Both empty-search-result
  and truly-empty-Available render the same "No matching tools" /
  no-message state respectively — no separate loading/error branch is
  introduced by this change beyond what `ThreadToolsBody` already has for
  the whole drawer.

## Testing

- `ui/test/thread-tools-drawer.test.tsx` (existing, needs a substantial
  rewrite): section membership (a wiki tool and a skill-gated tool both
  land in Built-in with their distinct captions; a selected tool lands in
  Assigned; an unselected, enabled tool lands in Available; a disabled,
  unselected tool appears nowhere), Add moves a row from Available to
  Assigned in local state without a network call, Remove moves a row back,
  Save sends the full resulting id list via the existing PUT mock, closing
  without Save issues no request, search filters Available only.
- No backend test changes — `use-thread-tools.ts` and the API layer are
  untouched.

## Evaluations

Not applicable — no system-prompt or agent-behavior change.
