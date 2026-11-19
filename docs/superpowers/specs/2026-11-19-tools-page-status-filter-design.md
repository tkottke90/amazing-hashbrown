# Settings → Tools Status Filter — Design

Today `ToolAccessTable` (`ui/src/pages/settings/tool-access-table.tsx`) always renders every catalog/MCP tool — enabled, disabled, Always-On Tool, Skill-Gated/Skill-Scoped alike — sorted alphabetically, narrowed only by the existing text search. A user who just wants to see what's active has to read past every disabled row to find it.

This adds a three-way All/Enabled/Disabled status filter, defaulting to "Enabled," that composes with the existing search (AND) and reads off the same `tool.enabled` field everywhere else in the app already treats as the source of truth — see `GLOSSARY.md`'s "Always-On Tool" and ADR-0073 for why that one field, with no category special-casing, is what the filter buckets on.

## Scope

All of it is `ui/src/pages/settings/tool-access-table.tsx` plus one new shared component. No API or type changes — `ResolvedToolSettingItem`/`ToolSettingItem.enabled` (`api/src/agents/tool-config.ts`, `ui/src/services/tool-settings-api.ts`) already carries exactly what the filter needs.

## New component: `ToolStatusFilter`

**`ui/src/components/ui/tool-status-filter.tsx`** — a third sibling to `ScaleToggle`/`DensityToggle` (`ui/src/components/ui/scale-toggle.tsx`, `density-toggle.tsx`), copying their exact structure (`RadioGroupPrimitive.Root`/`Item` from `radix-ui`, same `h-7`/`p-0.5` segmented-pill classes) but with three options instead of two:

```ts
const TOOL_STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
] as const;

export type ToolStatusFilterValue = 'all' | 'enabled' | 'disabled';
```

Same props shape as `DensityToggle` (`value`, `onChange`, `className`, rest spread onto `Root`), `data-slot="tool-status-filter"` / `"tool-status-filter-item"`, and ``data-testid={`tool-status-filter-${option.value}`}`` on each `Item` (record the three new testids in `e2e/AGENTS.md`'s data-testid table per that file's own instruction). Placed in `components/ui/` rather than `pages/settings/`, matching the existing precedent that `DensityToggle` lives there too despite having exactly one current caller (`dashboard-settings-panel.tsx`) — these are generic segmented-toggle atoms, not page-specific logic.

## Wiring into `ToolAccessTable`

New `statusFilter = useSignal<ToolStatusFilterValue>('enabled')` alongside the existing `search` signal (`tool-access-table.tsx:92`) — no `localStorage`/URL persistence, so it always initializes to `'enabled'` on mount, including after the Refresh button's `refreshToolSettings()` call (`:112-121`), since that only replaces `tools.value` and never touches this signal.

`filtered` (`:123-130`) gains the status predicate, applied after sort/before search text, AND'd with the existing query:

```ts
const filtered = useComputed(() => {
  const query = search.value.trim().toLowerCase();
  const sorted = [...tools.value].sort((a, b) => a.name.localeCompare(b.name));
  const byStatus = sorted.filter((t) => {
    if (statusFilter.value === 'enabled') return t.enabled;
    if (statusFilter.value === 'disabled') return !t.enabled;
    return true;
  });
  if (!query) return byStatus;
  return byStatus.filter(
    (t) => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
  );
});
```

Since `filtered` already recomputes on every `tools.value` write, `handleSaved` (`:108-110`) — the drawer's non-optimistic save callback — needs no change: toggling a tool's `enabled` in its drawer updates `tools.value`, which re-runs this computed and drops/adds the row from the current view immediately, satisfying the "disappear immediately" behavior settled in grilling.

`ToolStatusFilter` renders in the `CardContent` toolbar (`:179-186`), next to `ClearableInput`, inside a shared flex row:

```tsx
<div class="flex flex-wrap items-center gap-3">
  <ClearableInput
    value={search.value}
    onInput={(e) => (search.value = (e.target as HTMLInputElement).value)}
    placeholder="Search tools"
    aria-label="Search tools"
    className="max-w-[60ch]"
  />
  <ToolStatusFilter value={statusFilter.value} onChange={(v) => (statusFilter.value = v)} />
</div>
```

(Replaces the current bare `<ClearableInput />` plus the two stray `<br />` tags right after it at `:187-188`, which only existed to put vertical space before the table — `gap-3` on the Card's existing `space-y-3` content column already covers that spacing without the `<br />` hack.)

## Empty state

Row rendering (`ToolRow`, `:49-85`) is unchanged — the settled decision was to keep the dimmed/`(disabled)` treatment in every filter view, including "Disabled," so no new conditional styling there.

The empty-state message (`:189-190`) becomes filter-aware instead of always reading "No tools match your search":

```tsx
{filtered.value.length === 0 ? (
  <p class="py-4 text-center text-sm text-muted-foreground">{emptyMessage.value}</p>
) : ( ... )}
```

where `emptyMessage` is a `useComputed` choosing between the search-driven message (kept as-is when `search.value` is non-empty) and a status-driven one otherwise:

- `search.value` non-empty → "No tools match your search." (unchanged)
- `search.value` empty, `statusFilter.value === 'enabled'` → "No enabled tools."
- `search.value` empty, `statusFilter.value === 'disabled'` → "No disabled tools. Every tool is currently enabled."
- `statusFilter.value === 'all'` can't be empty unless `tools.value` itself is empty — falls back to the existing generic message.

## Out of scope

- Any persistence of the filter choice (localStorage, URL param, server-side) — explicitly rejected in grilling; every page load starts at "Enabled."
- Counts on the filter options (e.g. "Enabled (12)") — explicitly rejected in grilling; labels only.
- Any change to `ToolSettingsDrawer`, the PATCH/DELETE endpoints, or how `enabled` is resolved server-side (`resolveToolSettings`) — the filter only reads a field that already exists and is already correct.
- Any change to `thread-tools-drawer.tsx` (the separate per-thread tools drawer) — out of scope per the original request, which names only the Settings → Tools page.
- Eval suite changes — this is deterministic UI filtering with no LLM-facing behavior.

## Testing

Per the root `AGENTS.md`, all ship in the same PR:

- **Unit**: new `ui/test/tool-status-filter.test.tsx`, modeled directly on `density-toggle.test.tsx` — renders three radio items (All/Enabled/Disabled); reflects the given `value` as checked; calls `onChange` with the newly selected value; updates the checked item once the controlling value changes.
- **Unit**: `ui/test/tool-access-table.test.tsx` — new cases: defaults to showing only `enabled: true` rows on initial render; switching to "Disabled" shows only `enabled: false` rows (including an `alwaysOn: true` fixture, confirming it never appears there); switching to "All" shows every row regardless of `enabled`/`alwaysOn`/`category`; search text and status filter combine (AND) rather than either resetting the other; the "No disabled tools…" message appears when "Disabled" matches zero rows with an empty search box; clicking Refresh leaves a non-default filter selection (e.g. "All") untouched.
- **Unit fix (regression)**: `ui/test/settings-tools-panel.test.tsx`'s existing `'shows a disabled indicator for a globally-disabled tool'` test (`:70-76`) currently asserts a disabled row is visible under the table's current default (unfiltered) view. Once the default view becomes "Enabled," that row no longer renders on initial load — this is the AGENTS.md "test covers what you changed, update it" case, not a regression: the test needs to select the "All" (or "Disabled") filter option first (`fireEvent.click(screen.getByTestId('tool-status-filter-all'))`) before asserting `(disabled)` is visible.
- **E2E**: extend `e2e/tests/tool-settings-admin.spec.ts` (suite id 29) with a step — "Switch between All/Enabled/Disabled tool filters," expected outcome "Each view shows only the matching rows, defaulting to Enabled on load" — exercising the three-way toggle against `INITIAL_TOOLS` (`:72-81`, which already includes one `alwaysOn: true` row to assert against) via the new `tool-status-filter-*` testids, per `e2e/AGENTS.md`'s selector-strategy preference for `data-testid`.
