# Settings unsaved-changes UX

Issue: [tkottke90/amazing-hashbrown#136](https://github.com/tkottke90/amazing-hashbrown/issues/136)

## Problem

Across the Settings sub-pages, editing a field surfaces `SaveDiscardBar`
(`ui/src/pages/settings/save-discard-bar.tsx`) — but it's `bg-background`,
the same background as the page around it, with only a plain top border and
small ghost/default buttons. Nothing distinguishes "you have unsaved
changes" from the rest of the page.

Worse, navigating away never checks for unsaved changes. `SettingsView`
(`ui/src/pages/settings/index.tsx`) calls `route(...)` unconditionally on
section switch, and `ActivePanel` unmounts the previous panel immediately.
Each panel owns its own isolated dirty/form state via `useSettingsSection`
(`ui/src/pages/settings/use-settings-section.ts`) — nothing outside that one
panel instance knows it's dirty. The same is true leaving Settings entirely
via the app's left sidebar (`ThreadSidebar`,
`ui/src/components/thread-sidebar.tsx`). The codebase already has precedent
for warning before discarding unsaved work — `use-workspace-files.ts`'s
`closeTab` does a plain `confirm('Discard unsaved changes to "...")?')`
before closing a dirty file tab — just not here.

## Goals

- The save/discard bar reads as a distinct, hard-to-miss status, not two
  buttons blended into the page background.
- Switching Settings sections, or leaving Settings entirely via the app
  sidebar (nav links or thread switching), is blocked with a confirmation
  when the active section has unsaved changes.
- Closing or reloading the browser tab while dirty triggers the browser's
  own native "leave site" prompt.
- Dirty state becomes observable outside the currently-mounted panel,
  without restructuring how panels manage their own form state.

## Out of scope

- Browser back/forward (`popstate`) navigation. `preact-iso` has no
  navigation-guard hook, and back-button interception requires fighting the
  browser's own history stack (push a state back on cancel) — disproportionate
  complexity for a comparatively rare path. Flagged as a known gap, not
  silently dropped.
- A new `AlertDialog`/modal component for the confirmation prompt. No such
  primitive exists in `ui/src/components/ui` today, and this codebase's one
  existing precedent for this exact problem (`use-workspace-files.ts`'s
  `closeTab`) already uses a plain `confirm()`. This design reuses that,
  rather than introducing a second confirmation pattern alongside it.
- Restructuring `useSettingsSection`'s per-panel `data`/`form`/`isDirty`
  signals. They stay exactly as they are; only a thin registration layer is
  added on top.

## `SaveDiscardBar` visual redesign

`ui/src/pages/settings/save-discard-bar.tsx` changes, no prop changes:

- Background `bg-primary/10` (the same tint already used for "active" states
  elsewhere in Settings — e.g. `settings-nav.tsx`'s active item, the
  "Default" provider badge in `model-providers-panel.tsx`), `border-t
border-primary/30` instead of `bg-background border-border`.
- An elevation shadow so the bar visually lifts off the page instead of
  blending into it: `shadow-[0_-4px_12px_-4px_rgb(0_0_0_/_0.15)]` (same
  shadow direction/style `Layout` already uses on its main panel edge).
- A status label on the left — an `AlertCircle` icon (from `lucide-preact`,
  already a project dependency used throughout this file's siblings for
  other icons, e.g. this file's own `Loader2`) plus the text "Unsaved
  changes" — so the bar reads as a status the way a toast or badge does,
  not just two stray buttons.
- Save stays the primary button, Discard stays ghost; only the container
  gains weight.

No new design tokens are introduced — everything above composes existing
`--color-primary`/`--color-border` theme variables already used elsewhere in
Settings.

## Lifting dirty state

At any given moment, exactly one `useSettingsSection` consumer is ever
mounted: `ActivePanel` (`index.tsx`) renders exactly one panel by `section`,
and the one panel with sub-sections (`WorkspacesPanel`) renders exactly one
sub-section (`TrackersSection`) at a time via its own `activeSubsection`
signal. So a single shared "current guard" slot is sufficient — no
multi-entry registry is needed (there is currently no scenario where two
`useSettingsSection` instances are mounted simultaneously).

New module `ui/src/pages/settings/settings-guard.ts`:

```ts
import { signal } from '@preact/signals';

interface SettingsGuard {
  isDirty: boolean;
  discard: () => void;
}

export const activeGuard = signal<SettingsGuard | null>(null);

/**
 * Checks the currently registered dirty settings section (if any) before a
 * navigation proceeds. Returns true if it's safe to navigate — either
 * nothing is dirty, or the user confirmed leaving anyway (in which case the
 * dirty panel's changes are discarded so it doesn't come back stale).
 */
export function confirmNavigateAway(): boolean {
  const guard = activeGuard.value;
  if (!guard?.isDirty) return true;
  if (!confirm('You have unsaved changes. Leave without saving?')) return false;
  guard.discard();
  return true;
}
```

`useSettingsSection` registers itself into `activeGuard` via a `useEffect`
that re-runs when `isDirty.value`/`form`/`discard` identity changes, and
clears `activeGuard.value` back to `null` on unmount:

```ts
useEffect(() => {
  activeGuard.value = { isDirty: isDirty.value, discard };
  return () => {
    activeGuard.value = null;
  };
}, [isDirty.value]);
```

`useSettingsSection`'s own exported `data`/`form`/`isDirty`/`save`/`discard`
are unchanged — every panel keeps consuming the hook exactly as it does
today. This is additive.

## Wiring the guard into navigation (explicit call sites)

Considered and rejected: a single global capture-phase `click` listener on
`document` that inspects every click app-wide while something is dirty. It
would catch anchor clicks and `onClick`-driven `route()` calls from one
place, but it's implicit and hard to reason about — a generic listener
silently intercepting clicks anywhere in the app risks false positives
(e.g. a click on an unrelated modal trigger) and is awkward to unit test.

Instead, each of the small, known set of call sites that can actually
unmount a dirty Settings panel calls `confirmNavigateAway()` explicitly
before navigating — matching the codebase's existing style of an inline
`confirm()` at the point of action (`closeTab`), not a generic interceptor:

- **`SettingsView.handleNavigate`** (`ui/src/pages/settings/index.tsx`) —
  switching sections via `SettingsNav`:

  ```ts
  function handleNavigate(slug: SettingsSlug) {
    if (!confirmNavigateAway()) return;
    route(`/settings?section=${slug}`);
  }
  ```

- **`ThreadSidebar`**'s two direct `route()` calls
  (`ui/src/components/thread-sidebar.tsx`) — "New conversation" and clicking
  a thread row — each gets the same `if (!confirmNavigateAway()) return;`
  guard before calling `route(...)`.
- **`ThreadSidebar`**'s four nav `<a href>` tags (Inbox/Workspaces/Wiki/
  Settings) each get an `onClick`:

  ```tsx
  onClick={(e) => {
    if (!confirmNavigateAway()) e.preventDefault();
  }}
  ```

  When the guard allows the navigation, nothing extra happens — the
  anchor's default behavior (handled by `preact-iso`'s existing click
  interception) proceeds untouched, so opening in a new tab / middle-click
  is unaffected. Only the blocked case calls `preventDefault()`.

No other files change. `settings-guard.ts` and these two components are the
entire navigation-guard surface.

## Tab close / reload

A `beforeunload` listener, registered once at the app root
(`ui/src/app.tsx` or equivalent top-level component — wherever `Layout` is
mounted), guards the same `activeGuard` signal:

```ts
useEffect(() => {
  function handler(e: BeforeUnloadEvent) {
    if (activeGuard.value?.isDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  }
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}, []);
```

This is a no-op whenever nothing is dirty, so it's safe to register
unconditionally rather than only while `SettingsView` is mounted. The
browser renders its own native prompt here; its text isn't ours to control.

## Error handling / edge cases

- `save()`'s existing success/failure toasts are unchanged.
- When the guard triggers `discard()` (user chose "leave anyway"), it resets
  `form` to `data` exactly as the existing Discard button does — no new
  failure mode, and the panel (if the user comes back to that section) shows
  the last-saved state rather than stale edits.
- A section mid-save (`isSaving.value === true`) when the user tries to
  navigate: the guard checks `isDirty`, not `isSaving`. `isDirty` only
  becomes `false` once `save()` resolves and `data`/`form` are reconciled,
  so an in-flight save still blocks navigation — no special-casing needed.
  If the save then fails, the section is still dirty and still guarded,
  which is correct.

## Testing

Unit tests (`@testing-library/preact` + `jest`, matching
`ui/test/settings-use-settings-section.test.ts` and
`ui/test/settings-nav.test.tsx`):

- `ui/test/settings-guard.test.ts` (new): `confirmNavigateAway` returns
  `true` immediately when nothing is registered or not dirty (no `confirm()`
  call); when dirty, calls `confirm()`, and on confirmation calls the
  registered `discard()` and returns `true`; on cancellation returns `false`
  without calling `discard()`.
- Extend `ui/test/settings-use-settings-section.test.ts`: registers
  `activeGuard` on mount, updates it when `isDirty` flips, and clears it
  back to `null` on unmount.
- `ui/test/settings-save-discard-bar.test.ts` (new): renders with the new
  classes/label when `isDirty`, renders nothing when not — mirrors the
  existing `settings-nav.test.tsx` render-assertion style.

E2E (Playwright, matching `e2e/tests/settings-navigation.spec.ts`'s
mocked-API pattern): new suite `e2e/tests/settings-unsaved-changes.spec.ts`,
id `24` (next free id after the existing suites' max of `23`):

- Dirty a field in General, click "Storage" in `SettingsNav`, cancel the
  `confirm()` dialog (Playwright's `page.on('dialog', ...)` — the same
  mechanism used for native dialogs elsewhere in this suite) → still on
  General, field retains the edit.
- Same setup, accept the dialog → navigates to Storage, and returning to
  General shows the last-saved value (proving `discard()` ran).
- Dirty a field, click a sidebar nav link (e.g. Wiki) → same
  cancel/accept behavior as above, confirming the guard covers leaving
  Settings entirely, not just switching sections.
- No unsaved changes → clicking away navigates immediately with no dialog.
