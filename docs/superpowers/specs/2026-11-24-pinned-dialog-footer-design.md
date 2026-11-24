# Pinned Dialog Footer — Design

**Date:** 2026-11-24
**Scope:** `lib/preact-dialog` (`Drawer`, `BottomSheet`) and every consumer of them in `ui/`

## Problem

`Drawer` and `BottomSheet` give callers a header and nothing else. Every
consumer hand-builds its own scrolling body and footer bar, so the layout is
copy-pasted with drifting classes (`flex-1` vs `grow`, footer with or without
`shrink-0`, padding of `p-3` / `px-3 py-2` / `p-4` / `pt-4`, some panels on
Dialog's default `p-6`, others overriding it with `!p-0`).

Where the copy-paste is wrong, the footer actions are unreachable:

- `pages/dashboard/dashboard-settings-panel.tsx` has no scroll region. Its
  Cancel/Save row sits inline at the end of the form. The `<dialog>` is
  `overflow-hidden`, so on a short viewport the actions are clipped and
  cannot be scrolled to.
- `pages/settings/skill-drawer.tsx` (`EditSkillView`) wraps tab content in a
  scroll div, and `skill-details-tab.tsx` / `skill-evals-tab.tsx` render
  their footers inside it, so the footers scroll away with the content.
- `BottomSheet` wraps all children in a single `overflow-y-auto` div, so any
  footer placed in a sheet (e.g. the mobile quick-add form) scrolls with the
  content by construction.

## Goal

Footer actions in a `Drawer` or `BottomSheet` are always pinned to the bottom
of the panel and never part of the scrollable content, enforced by shared
structure rather than by each caller remembering the right classes.

## Non-goals

- `Modal` is unchanged.
- No visual redesign of the header, and no change to open/close behaviour.

## Design

### 1. Library: composable layout pieces

New file `lib/preact-dialog/src/DialogLayout.tsx`, exported from `index.ts`:

```tsx
interface DialogSectionProps {
  className?: string;
  children: ComponentChildren;
}

export function DialogBody({ className, children }: DialogSectionProps) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('flex-auto min-h-0 overflow-y-auto px-5 py-4', className)}
    >
      {children}
    </div>
  );
}

export function DialogFooter({ className, children }: DialogSectionProps) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 border-t border-neutral-400/50 px-5 py-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
```

- `cn` is tailwind-merge, so caller classes **override** defaults
  (`className="p-0"` removes the padding; `justify-between` replaces
  `justify-end`; `border-border` replaces the neutral border). No `!` needed.
- `flex-auto` (not `flex-1`) preserves the WebKit auto-height fix documented
  in `Dialog.tsx` — required for `BottomSheet`, which has no definite height.
- The default border is the library's neutral `border-neutral-400/50`
  (matching `Dialog`'s skin); the package has no access to app theme tokens.
  App consumers pass `className="border-border"` if they want the theme token.
- `data-slot` is the stable hook for tests and E2E.

**Usage contract.** `DialogBody` and `DialogFooter` must be direct flex
children of the dialog's content wrapper. A `<form>` wrapping both must use
`className="contents"` so it does not participate in the flex layout:

```tsx
<Drawer title="Edit role" trigger={trigger}>
  <form onSubmit={save} className="contents">
    <DialogBody>{/* fields */}</DialogBody>
    <DialogFooter>
      <Button type="button" variant="ghost" onClick={() => close()}>
        Cancel
      </Button>
      <Button type="submit">Save</Button>
    </DialogFooter>
  </form>
</Drawer>
```

If a caller forgets `contents`, the footer is no longer pinned, but it stays
reachable because the body still scrolls inside the form. This is accepted;
no runtime warning is added.

### 2. Library: `Drawer` and `BottomSheet` changes

- **`Drawer.tsx`**: add `p-0` to `DRAWER_CLASSNAME`. The panel no longer
  carries padding; header (`px-5 pt-4 pb-2`, unchanged), body, and footer
  own their own, all on a shared `px-5`.
- **`BottomSheet.tsx`**:
  - Remove the internal `<div className="flex-auto min-h-0 overflow-y-auto">`
    wrapper. Children render directly in the content wrapper's flex column;
    `DialogBody` is the scroller.
  - Add `p-0` to `BOTTOM_SHEET_CLASSNAME` and default
    `headerClassName` to `px-5 pt-4 pb-2` (caller value wins if provided),
    matching `Drawer`.
  - **Fix:** `{...props}` is currently spread after `contentClassName`, so a
    caller's `contentClassName` replaces the slide/blur classes instead of
    extending them (`provider-model-picker.tsx` hits this). Destructure
    `contentClassName` and merge: `cn(BOTTOM_SHEET_CONTENT_CLASSNAME, contentClassName)`.
- **Breaking change (intentional):** a `BottomSheet` child not wrapped in
  `DialogBody` no longer scrolls. All consumers are migrated in the same
  change.
- **`README.md`**: add a "Body & footer layout" section covering the
  components, the `className` override behaviour, and the
  `<form className="contents">` pattern with the reason it is needed.

### 3. Consumer migration

General rule per consumer: outer `<form>`/`<div>` becomes `className="contents"`,
the scroll div becomes `<DialogBody>`, the footer bar becomes `<DialogFooter>`.
Remove hand-rolled layout classes (`flex-1 min-h-0 overflow-y-auto`,
`border-t … shrink-0`) and panel padding overrides (`!p-0`, `p-0!`, `py-4`).
Keep skin overrides (`!bg-background`, `!rounded-none`, `border-l`, widths).
Footers pass `className="border-border"` to keep the current app border colour.

**Drawers**

| File                                                    | Change                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/pages/dashboard/dashboard-settings-panel.tsx`   | **Bug fix.** Description, fields, error, and "Delete dashboard" go in `DialogBody`; Cancel/Save go in `DialogFooter`.                                                                              |
| `ui/src/pages/dashboard/widget-drawer.tsx`              | Standard swap; drop `py-4` on the panel.                                                                                                                                                           |
| `ui/src/pages/settings/role-drawer.tsx`                 | Standard swap; drop `py-4`.                                                                                                                                                                        |
| `ui/src/pages/settings/mcp-server-drawer.tsx`           | Standard swap; drop `py-4`.                                                                                                                                                                        |
| `ui/src/components/tool-settings-drawer.tsx`            | Standard swap; footer keeps `justify-between`.                                                                                                                                                     |
| `ui/src/components/thread-tools-drawer.tsx`             | Standard swap; drop the outer `px-6` wrapper.                                                                                                                                                      |
| `ui/src/components/task-drawer.tsx`                     | Already correct; swap to components for consistency.                                                                                                                                               |
| `ui/src/pages/workspaces/workspace-settings-drawer.tsx` | Already correct; swap to components.                                                                                                                                                               |
| `ui/src/pages/workspaces/index.tsx`                     | Restructure so the `<form className="contents">` wraps the whole drawer (body + footer); remove the `id="create-workspace-form"` / `form="create-workspace-form"` pairing.                         |
| `ui/src/pages/settings/skill-drawer.tsx`                | **Bug fix.** `CreateSkillForm`: standard swap. `EditSkillView`: tab bar stays pinned at the top; the tab container changes from a scroll div to `flex flex-col flex-auto min-h-0` (non-scrolling). |
| `ui/src/pages/settings/skill-details-tab.tsx`           | Render own `DialogBody` + `DialogFooter` (footer keeps `justify-between`).                                                                                                                         |
| `ui/src/pages/settings/skill-evals-tab.tsx`             | Render own `DialogBody` + `DialogFooter`.                                                                                                                                                          |
| `ui/src/pages/settings/skill-files-tab.tsx`             | Two-pane layout with no footer. Wrap in `<DialogBody className="p-0">` so it still scrolls after the container stops scrolling, without adding padding to the panes.                               |

**BottomSheets**

| File                                                                    | Change                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/pages/workspaces/task-board/task-list-mobile.tsx` (quick-add)   | Fields in `DialogBody`; Cancel/Add in `DialogFooter`; form becomes `contents`.                                                                                                                                                                                                                                                         |
| `ui/src/pages/workspaces/task-board/task-list-mobile.tsx` (reply sheet) | `<DialogBody><ReplyForm … /></DialogBody>`. `ReplyForm` is shared with the inline board callout, so its Send button stays inline.                                                                                                                                                                                                      |
| `ui/src/pages/workspaces/workspace-details-sheet.tsx`                   | Content in `DialogBody`; no footer.                                                                                                                                                                                                                                                                                                    |
| `ui/src/pages/workspaces/workspace-actions-sheet.tsx`                   | Content in `DialogBody`; no footer.                                                                                                                                                                                                                                                                                                    |
| `ui/src/components/provider-model-picker.tsx`                           | List div is wrapped in `<DialogBody className="px-2">`; the inner div keeps `flex flex-col gap-1` and its `data-slot="provider-model-picker-sheet-list"`, minus its own `min-h-0 flex-1 overflow-y-auto`. Its `contentClassName="gap-4 h-full"` and `className` height overrides stay. Benefits from the `contentClassName` merge fix. |

## Testing

### Library unit tests (Jest, `lib/preact-dialog/test/`)

jsdom has no layout engine; these assert the structural contract only.

- `DialogLayout.test.tsx` (new):
  - `DialogBody` renders children in a scroll region (`overflow-y-auto`, `min-h-0`) with default padding.
  - Caller `className="p-0"` replaces default padding (no `px-5` in output) — proves override, not append.
  - `DialogFooter` renders with `shrink-0` and `border-t`; caller `justify-between` replaces `justify-end`.
- `BottomSheet.test.tsx`:
  - Children are not wrapped in a library scroll div (guards the breaking change).
  - Caller `contentClassName` is merged — slide classes (`translate-y-full`) remain (regression test for the merge fix).
  - Panel has `p-0`; default header padding applied, caller `headerClassName` wins.
- `Drawer.test.tsx`: panel has `p-0`.

### UI unit tests (Jest, `ui/`)

Existing drawer/sheet tests stay green. Tests that select a body or footer
by a removed class switch to `data-slot`. No new per-consumer layout tests.

### E2E (Playwright)

Shared helper `expectPinnedFooter(page, dialog)` in `e2e/lib/`: asserts the
footer's bounding box is fully inside the viewport, scrolls the
`[data-slot="dialog-body"]` to the bottom, and asserts the footer's position
is unchanged. Run at a short viewport (e.g. 800×500) so content overflows.

1. `e2e/tests/dashboard.spec.ts` — open Dashboard settings; footer pinned; Save clickable without scrolling.
2. `e2e/tests/task-board-mobile.spec.ts` — open quick-add on a phone viewport; footer pinned.
3. `e2e/tests/create-skill.spec.ts` — create-skill footer pinned; add a step that opens an existing skill's Details tab and asserts its footer is pinned.

All three are CI-safe (no `@llm` tag).

### Manual check

Open each of the 14 migrated overlays in the dev server at desktop and
mobile widths and confirm header/body/footer render correctly.

## Risks

- **`display: contents` on `<form>`**: removes the form's box only; submit,
  validation, and the `form` element's semantics are unaffected. Forms here
  are unnamed, so no landmark is lost.
- **Missed consumer**: a `BottomSheet` without `DialogBody` silently loses
  scrolling. Mitigated by migrating every consumer found by grepping for
  `<BottomSheet` / `<Drawer` and by the manual check.
