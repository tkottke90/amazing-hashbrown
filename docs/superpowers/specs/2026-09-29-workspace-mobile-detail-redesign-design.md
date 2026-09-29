# Workspace Detail Mobile Redesign — Design

**Date:** 2026-09-29
**Status:** Draft
**Related:** [Issue #129](https://github.com/tkottke90/amazing-hashbrown/issues/129) (mobile header eats ~50% of viewport), [Kanban Board v2 design](./2026-09-28-kanban-board-v2-design.md) (mobile task list this reuses as-is)

---

## Goal

Below the `lg` breakpoint (1024px), replace `WorkspaceDetailView`'s single inline header block — breadcrumb, title/status/actions row, wrapped metadata chips, underlined tab row, all stacked before any tab content is visible — with the compact chrome from an already-approved UX mockup: a ~52px header, a tab strip docked above the existing mobile bottom app bar (`Layout`), and two new bottom sheets for details and secondary actions. Desktop (`≥lg`) is unchanged. One spec, one PR.

The mockup also designs a mobile mode for the Files tab (list → drill-down), which issue #129's text doesn't mention but which is necessary: the current Files tab is a fixed split pane with no responsive fallback and simply breaks below `lg` today. It's included here rather than filed separately, since it's part of the same approved mockup and touches the same viewport-branching mechanism.

---

## Problem

- The header block (`ui/src/pages/workspaces/[id].tsx:225-342`) — breadcrumb, title + status dot, action buttons, metadata chip row, tab row — can eat roughly half a phone screen before any tab content renders.
- Metadata chips (`ws.location`, git/wiki/JS/Python badges, due date) wrap onto multiple lines at narrow widths, compounding it.
- The tab row is a plain underlined button row under the title, not using the app's existing mobile bottom app bar (`ui/src/components/layout.tsx:50-85`), which already has `navStart`/`navEnd`/`onAddClick` slots that `WorkspaceDetailView` currently ignores.
- Secondary actions (Close project / Abandon / Delete) are inline buttons squeezed next to the title instead of a better-suited spot.
- The Files tab (`ui/src/pages/workspaces/files-tab.tsx`) is a fixed 250px-tree + editor split pane with no responsive behavior at all — below `lg` it doesn't reflow, it just breaks.
- The Tasks tab (`task-list-mobile.tsx`) and the app's Menu sheet (`Layout`'s shadcn `Sheet`) already match the approved mockup's mobile design as-is — no changes needed there. This design is scoped to what's actually missing: header/nav chrome and the Files tab.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                        | Rationale                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Below `lg`, header collapses to ~52px: back arrow (replaces breadcrumb), title, status dot, an icon cluster (Git / Wiki / due date) that opens a Details sheet. Desktop header is untouched.       | Matches the approved mockup and issue #129's ask directly; the breadcrumb's only real destination (`/workspaces`) is what a back arrow already implies. |
| D2  | The Overview/Tasks/Files/Chat tab strip becomes a segmented control passed into `Layout`'s `navStart`, docked above the bottom app bar, instead of an underlined row under the title.               | Reuses the existing bottom-bar pattern per the issue's explicit ask, instead of inventing a new nav pattern.                                     |
| D3  | Tab strip shows an amber dot on "Tasks" when the workspace has any task in the board's `attention` lane (`board.lane === 'attention'`, from the Kanban v2 design).                                 | Reuses the existing urgency signal already computed for the mobile task list instead of adding a parallel one.                                  |
| D4  | Bottom app bar's `onAddClick`/`addLabel` is set per active tab: Overview and Tasks → "New task" (opens the existing quick-add `BottomSheet` in `task-list-mobile.tsx`); Files → "Upload file"; Chat → "New chat". | Matches the mockup 1:1; Overview has no create action of its own, so it falls back to the same "New task" the Tasks tab already offers.          |
| D5  | A new **Details sheet** (`BottomSheet`) shows the same metadata already computed today (`ws.location`, `ws.git`, `ws.wikiId`, `ws.javascript`, `ws.python`, `proj.dueAt`) read-only. No new fields, no new endpoints — pure repackaging, confirmed with the user.                                   | The header no longer has room for a wrapped chip row; the data itself doesn't change.                                                           |
| D6  | A new **Actions sheet** (`BottomSheet`, opened via the bottom bar's `navEnd` "•••") wraps the *existing* `WorkspaceSettingsDrawer` trigger (Edit), `handleCloseIntent('close'\|'abandon')`, `handleDelete`, and `<ThemeToggle />` — same handlers, same visibility rules (`!isTerminal` for Edit, `isProj && projectStatus === 'active'` for Close/Abandon, Delete always shown) already in `[id].tsx` today. | No new business logic; only where these actions live changes.                                                                                    |
| D7  | Files tab gets a mobile single-pane mode driven by the *existing* `activeTabPath`/`openTabs` signals: no tab open → full-width `FileTree` + `GitControls`; a tab open → full-width `EditorPanel` with a back arrow that clears `activeTabPath`. Desktop split pane is untouched.                | A new interaction model, but no new state — same signals `files-tab.tsx` already manages, just a different render depending on viewport.        |
| D8  | Chat tab hides the tab strip and bottom app bar while `ChatInput` has focus, and restores them on blur.                                                                                             | Reclaims space from the on-screen keyboard; matches the mockup's "strip and bar hidden while typing" frame. Confirmed as focus-driven, not text-driven. |
| D9  | `useIsWideBoardViewport` (`ui/src/hooks/use-media-query.ts`) is renamed `useIsDesktopViewport`; behavior (`min-width: 1024px`) is unchanged.                                                          | It's about to gate the header, tab strip, and Files tab in addition to the task board — its board-specific name and doc comment no longer fit.  |
| D10 | No new API fields, endpoints, or workspace/task model changes anywhere in this design.                                                                                                              | Confirmed with the user — this is a UI-only reshuffle of chrome around data and handlers that already exist.                                    |

---

## 1. Shared viewport hook

`ui/src/hooks/use-media-query.ts`: rename `useIsWideBoardViewport` → `useIsDesktopViewport` (same `(min-width: 1024px)` query, same implementation). Update its doc comment to describe it as the app-wide mobile/desktop workspace-chrome gate, and update its one existing call site (`TasksTab` in `[id].tsx`) plus its test file's describe/name strings. No other behavior change.

---

## 2. Mobile header (`< lg`)

New component, `ui/src/pages/workspaces/workspace-mobile-header.tsx` (page-only — used by one page — per `ui/AGENTS.md`'s "where does this file go?"):

- Back arrow → `route('/workspaces')` (replaces the breadcrumb's only real destination).
- Title (`ws.name`), truncated; status dot (same `isTerminal`/`isActive` logic already in `[id].tsx`).
- Icon cluster: Git branch icon (if `ws.git`), Wiki icon (if `ws.wikiId`), Calendar icon (if `proj.value?.project.dueAt`) — tapping any of them opens the Details sheet (single shared trigger, not per-icon).
- Rendered by `WorkspaceDetailView` in place of today's header block when `!useIsDesktopViewport()`.

`WorkspaceDetailView` keeps today's header block, unchanged, for `useIsDesktopViewport() === true`.

---

## 3. Details sheet

New component, `ui/src/pages/workspaces/workspace-details-sheet.tsx`. A `BottomSheet` (`@tkottke90/preact-dialog`, matching the pattern already established in `task-list-mobile.tsx` — not the shadcn `Sheet` `Layout`'s menu uses), controlled via an `open` signal owned by the mobile header (no visible trigger prop; the header's icon cluster tap sets the signal, per `Dialog.tsx`'s controlled-open support).

Content: the same rows the desktop metadata chip row shows today — Location, Git (branch/remote), Wiki (link), JavaScript/Python badges, Due date — read-only, no form. Pure presentation over the same `ws`/`proj` data `[id].tsx` already computes; no new component state beyond the open signal.

---

## 4. Actions sheet

New component, `ui/src/pages/workspaces/workspace-actions-sheet.tsx`. Another `BottomSheet`, opened from `Layout`'s `navEnd` slot (a "•••" icon button) while on this page, controlled the same way as the Details sheet.

Rows, each reusing the exact existing handler/component from `[id].tsx`, with the exact same visibility conditions as today:

- **Edit** — renders `WorkspaceSettingsDrawer`'s trigger (shown when `!isTerminal`).
- **Close project** / **Abandon** — call `handleCloseIntent('close' | 'abandon')` (shown when `isProj && projectStatus === 'active'`).
- **Delete** — calls `handleDelete()` (always shown).
- **Theme** — the existing `<ThemeToggle />` component, unchanged.

No new confirm/toast logic — `handleDelete`/`handleCloseIntent` already own their own `confirm()` and toast behavior; the sheet only relocates the buttons that call them.

---

## 5. Tab strip

New component, `ui/src/pages/workspaces/workspace-tab-strip.tsx`. A segmented control over the same four `DetailTab` values `[id].tsx` already switches on, passed into `Layout`'s `navStart` prop while `!useIsDesktopViewport()`. Renders an amber dot on "Tasks" when `workspaceTasks.value.some((t) => t.board.lane === 'attention')` (the same `board` projection `task-list-mobile.tsx` already renders from — see Kanban v2 design §1.2). No new count/urgency logic.

`WorkspaceDetailView` sets `Layout`'s `navStart` (the tab strip), `navEnd` (the Actions sheet's "•••" trigger), and `onAddClick`/`addLabel` (per D4) unconditionally — no viewport check needed here. `Layout`'s entire bottom-bar `<nav>` (`layout.tsx:50-85`) already carries `lg:hidden`, so none of this renders on desktop regardless of what's passed; desktop keeps seeing nothing from these slots, same as today.

---

## 6. Files tab mobile mode

`ui/src/pages/workspaces/files-tab.tsx` branches on `useIsDesktopViewport()`:

- **Desktop** (current behavior, untouched): fixed 250px `FileTree` + editor split pane, tab strip, `GitControls`.
- **Mobile**: single full-width pane.
  - No open tab (`openTabs.value.length === 0` or none active) → `FileTree` + `GitControls`, full width. "Upload file" is reachable via the bottom bar's `onAddClick` (D4) instead of an inline button.
  - A tab is active → `EditorPanel` for `activeTabPath`, full width, with a back arrow (in place of the open-tabs strip) that clears `activeTabPath` back to `null`/tree view.
  - All open tabs stay mounted exactly as today (`openTabs.value.map(...)`, hidden via the existing `cn(..., activeTabPath.value !== tab.path && 'hidden')` pattern) — only which pane is visible changes, not tab lifecycle or editor state.

---

## 7. Chat tab focus-hide

`ChatInput` (`ui/src/components/chat-input.tsx`) gains an `onFocus`/`onBlur` callback prop. `WorkspaceChatTab` tracks a `chatInputFocused` signal from it. `WorkspaceDetailView` reads that signal (lifted no higher than needed — likely via a small callback passed down alongside `onGoToChat`, mirroring how `TasksTab` already receives `onGoToChat`) to skip rendering the tab strip and to tell `Layout` to hide the bottom app bar while `!useIsDesktopViewport() && tab.value === 'chat' && chatInputFocused.value`. Reappears on blur. No change to chat message/tool-call rendering — already correct today.

`Layout` needs a way to hide its bottom nav on request — a new optional prop (e.g. `hideBottomBar?: boolean`) that conditionally omits the `<nav>`/`<Sheet>` block, defaulting to `false` everywhere else.

---

## 8. Testing

Per root `AGENTS.md`, every UI-behavior change ships with dev tests and E2E in the same PR.

**Jest**

- `workspace-mobile-header` — renders back arrow/title/status dot/icon cluster conditionally on `ws.git`/`ws.wikiId`/`proj.dueAt`; tapping the cluster opens the Details sheet.
- `workspace-details-sheet` — renders the same fields the desktop chip row shows, for a given `ws`/`proj`.
- `workspace-actions-sheet` — each row's visibility follows the same conditions as today's inline buttons; each row invokes the same handler (spy, per the orchestration-test convention).
- `workspace-tab-strip` — amber dot appears iff a task has `board.lane === 'attention'`; tab click updates `tab.value`.
- `files-tab` mobile branch — tree-only view when no tab active; editor-only view + back arrow when a tab is active; back arrow clears `activeTabPath` without unmounting other tabs.
- `workspace-chat-tab` — focus/blur on `ChatInput` flips the lifted focus signal.
- `layout` — `hideBottomBar` omits the nav.
- Rename `useIsWideBoardViewport` → `useIsDesktopViewport` in its existing test file.

**Playwright** (`@user-workflow`, mobile viewport per existing `test.use({ viewport: ... })` convention — no mobile Playwright project exists yet, per Kanban v2's implementation note 10)

- Open the Details sheet from the header icon cluster; verify metadata shown.
- Open the Actions sheet; trigger Close/Abandon/Delete (mocked confirm) and verify the same behavior as today.
- Switch tabs via the tab strip; verify the amber dot appears/disappears with a seeded "needs attention" task (mock via `page.route()` per e2e/AGENTS.md's SSE/API mocking pattern).
- Files: drill into a file from the tree, verify back arrow returns to the tree without losing unsaved edits in another open tab.
- Chat: focus the input, verify tab strip/bottom bar hide; blur, verify they reappear.

**Evals:** none — no agent-facing behavior changes.

---

## PR notes

Issue #129 has no entry in `TODO_LIST.md`, so no TODO update is required. The PR description should note the Files-tab mobile mode as an addition beyond issue #129's literal text, justified by the same approved mockup.

---

## Out of scope

- Any change to the Tasks tab's content, grouping, or actions (`task-list-mobile.tsx`) — already matches the approved mockup as merged.
- Any change to the Menu sheet (`Layout`'s existing shadcn `Sheet`) — already matches the approved mockup as-is ("3a" per the mockup's own notes).
- Any change to chat message/tool-call rendering (`ThreadMessageItem`) — already correct.
- New workspace/task fields, new API endpoints, or any backend change.
