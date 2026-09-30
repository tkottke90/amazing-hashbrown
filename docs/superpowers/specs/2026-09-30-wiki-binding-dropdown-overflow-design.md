# Wiki Binding Dropdown Overflow Fix

**Issue:** [tkottke90/amazing-hashbrown#217](https://github.com/tkottke90/amazing-hashbrown/issues/217)

## Problem

The wiki-binding `<Select>` in the create-workspace drawer
(`ui/src/pages/workspaces/index.tsx`, `CreateWorkspaceForm`) renders each
wiki's `domain` field as the visible option text — both in the always-visible
trigger (`SelectValue`) and in every row of the open menu (`SelectItem`).
`domain` is a free-text, one-sentence description (see "Data model note"
below), not a short name. Radix's `SelectItem` has no width cap, so a long
description forces the popover — and by extension the drawer around it —
wide, producing the ~30vw drawer expansion and horizontal scroll reported in
the issue.

## Data model note

The issue's acceptance criteria asks to show "only the wiki name" in the
dropdown and the description in the menu. Today there is no persisted `name`
field for a wiki — `WikiEntry` (`lib/llm-wiki/src/types.ts`) only stores
`id` (a slug, e.g. `homelab`), `domain` (the description), `tags`, and
`status`. A `name` is accepted transiently at wiki-creation time but is
never written to `registry.json`.

Adding a real `name` field would mean a schema change, a `registry.json`
migration, and an API change — well beyond what a frontend drawer-overflow
bug warrants. This fix instead uses the existing `id` (slug) as the short
label, and keeps `domain` as the description. Introducing a proper `name`
field is out of scope for this fix and can be tracked separately if wikis
need human-friendly names in the future.

## Fix

Scope: `ui/src/pages/workspaces/index.tsx` only. No backend/API changes.

**Trigger (`SelectValue`):** change the selected-wiki branch from
`d.domain` to `d.id`. `SelectTrigger` already clamps its value to one line
(`*:data-[slot=select-value]:line-clamp-1` in `select.tsx`), so a slug-length
string never threatens layout.

**Menu item (`SelectItem`):** replace the plain-text children with a
two-line block, matching the pattern already used for the Skill/Tool
autocomplete popups in `ui/src/components/chat-input.tsx` (referenced
directly in the issue's developer notes):

```tsx
<SelectItem key={d.id} value={d.id}>
  <div className="font-mono text-sm font-semibold">{d.id}</div>
  <div className="text-xs text-muted-foreground max-w-[70ch] line-clamp-2">{d.domain}</div>
</SelectItem>
```

- Primary line: `d.id`, bold/mono — the short label.
- Secondary line: `d.domain`, muted, capped with `max-w-[70ch] line-clamp-2`.
  Two lines is enough for a "one-sentence description" (Skill/Tool use 3-4
  lines for potentially longer content). The `max-w` + `line-clamp`
  combination is what fixes the overflow: it bounds both line length and
  wrapped height, so the popover can't be forced wide.

This reuses Tailwind's `line-clamp` utility, already in use elsewhere in the
codebase (`chat-input.tsx`) — no new dependency or Tailwind config change.

**`None` / `Create new wiki…` items:** unchanged. They're short static
strings and aren't affected by the bug.

## Testing

`ui/test/workspace-create-form.test.tsx`, "Wiki binding section" describe
block:

- Update existing assertions that expect the trigger to display `d.domain`
  for a selected wiki — it now displays `d.id`.
- Add a case with a long `domain` string (e.g. >200 chars) verifying:
  - the trigger's displayed text is unaffected (still just `d.id`), and
  - the open menu row for that wiki carries the line-clamp class and renders
    both `d.id` and `d.domain` text — asserting behavior (clamp applied,
    both fields present) rather than pixel width, since a layout-overflow
    regression is hard to assert directly in jsdom.

No other test files are affected — `workspace-settings-drawer.tsx`'s
read-only wiki display is out of scope (not a select, not implicated in the
bug).
