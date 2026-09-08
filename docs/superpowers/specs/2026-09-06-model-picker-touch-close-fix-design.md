# Model Picker Touch Sub-Menu Close Fix — Design

**Date:** 2026-09-06
**Status:** Approved
**Issue:** [#130 — Model picker sub-menu still closes before selection — Firefox/Safari mobile only](https://github.com/tkottke90/amazing-hashbrown/issues/130)

---

## 1. Problem & Goal

The provider→model sub-menu bug from #113 ("Model sub-menu closes before user can select a model") is back, reported only on mobile Firefox and mobile Safari — desktop mouse and keyboard work fine. `e2e/tests/chat-model-picker.spec.ts`'s existing mobile-tap test (added on this branch, commit `734e7b7`) already passes under Chromium's touch emulation, which is exactly why this reproduces only in real Firefox/Safari mobile and wasn't caught by CI.

Goal: make touch selection reliable on Firefox and Safari mobile, without changing desktop mouse/keyboard behavior or the menu's visual/nesting structure.

Note: `e2e/playwright.config.ts` currently defines Chromium-only projects, so no automated engine in this repo can reproduce the Firefox/Safari-specific race directly. Adding real Firefox/WebKit projects is tracked separately as [#145](https://github.com/tkottke90/amazing-hashbrown/issues/145) and is out of scope here. This fix is verified by unit/e2e regression tests plus manual testing on real/emulated Firefox and Safari mobile.

---

## 2. Root Cause

The #113 fix (`docs/superpowers/specs/2026-08-31-model-picker-submenu-fix-design.md`) made the provider→model `Sub`'s open state app-controlled in both `ui/src/components/provider-model-picker.tsx` (the per-provider model list) and `ui/src/components/chat-input.tsx` (the outer "Provider" `Sub` wrapping it), driven by custom `onPointerEnter`/`onPointerLeave` handlers: entering opens immediately, leaving schedules a close after `MODEL_SUBMENU_CLOSE_GRACE_MS` (200ms) unless the pointer/focus re-enters first.

Verified against the installed `radix-ui` package's (`1.6.1`) upstream `menu.tsx` source: Radix's own internal pointer-hover handlers (`MenuItemImpl.onPointerMove`/`onPointerLeave`, `MenuSubTrigger.onPointerMove`/`onPointerLeave`, `MenuContentImpl.onPointerMove`) are all wrapped in a `whenMouse()` helper that no-ops for any `event.pointerType !== 'mouse'`. Radix opens a `Sub` for touch through a wholly separate path — `MenuSubTrigger`'s `onClick` calls `context.onOpenChange(true)` on tap, independent of hover timing — and never schedules a hover-close for touch internally.

Our own `onPointerEnter`/`onPointerLeave` handlers, added on top of Radix's primitives for the #113 fix, never adopted that same mouse-only guard. `pointerenter`/`pointerleave` are dispatched for touch too (with `pointerType: 'touch'`), just with inconsistent timing/ordering across engines relative to a tap's `pointerup`. Our unconditional `scheduleProviderClose`/`scheduleProviderMenuClose` calls on `pointerleave` treat that touch-originated leave as a real "pointer moved away" signal and arm the 200ms close timer — which then races the user's next tap into the sub-menu. This is self-inflicted: it's our own code reintroducing exactly the hover-fragility Radix's own primitives already engineered around.

---

## 3. Fix Design

**Scope:** `ui/src/components/provider-model-picker.tsx` and `ui/src/components/chat-input.tsx` only — the same two files #113 touched. No change to `rate-modal.tsx` or `ui/src/components/ui/dropdown-menu.tsx`, and no change to the menu's visual/nesting structure.

Add a small `whenMouse`-style guard, mirroring Radix's own internal helper, and apply it to every custom pointer-hover handler added for #113:

- `provider-model-picker.tsx`: `onPointerEnter`/`onPointerLeave` on `DropdownMenuSubTrigger` and `DropdownMenuSubContent` (currently calling `openProviderNow`/`scheduleProviderClose` unconditionally) become no-ops when `event.pointerType !== 'mouse'`.
- `chat-input.tsx`: the outer "Provider" `Sub`'s equivalent `onPointerEnter`/`onPointerLeave` handlers get the same guard.
- `onFocus` (`keepOpenOnFocus`/`keepProviderMenuOpenOnFocus`) is untouched — focus events carry no pointer type and aren't part of this bug.
- `onOpenChange` on both `DropdownMenuSub`s is untouched — it still needs to handle Radix's own click/keyboard-driven open calls (which are pointer-type-agnostic or keyboard-driven), and remains where `openProviderNow`/`openProviderMenuNow` and `scheduleProviderClose`/`scheduleProviderMenuClose` get invoked for the mouse-hover path.

**Result for touch:** a tap opens a provider or its model list via Radix's own `onClick` → `onOpenChange(true)` path, unchanged from today (this already works — the issue's own repro confirms the sub-menu opens). Nothing in our code schedules a close for touch anymore, because the only source of that scheduling — our own hover handlers — now ignores non-mouse pointer types entirely. The sub-menu then only closes via: selecting a model (existing behavior — the whole menu tree unmounts), tapping a different sibling provider (already reassigns the shared `openProvider`/equivalent state instantly, unaffected by this change), or tapping fully outside the menu tree (Radix's own root-level `DismissableLayer`, a separate mechanism this fix doesn't touch).

**Explicit trade-off:** tapping an already-open provider's trigger a second time will not collapse it — Radix's own `onClick` handler only opens (`if (!context.open) context.onOpenChange(true)`), never toggles closed. This is pre-existing Radix behavior, not a regression introduced here, and is not part of what #130 reports, so it is not addressed by this fix.

---

### 3a. Addendum — the `whenMouse` fix was real but incomplete; the actual blocker was a second, deeper bug

After the `whenMouse` fix above shipped in [PR #147](https://github.com/tkottke90/amazing-hashbrown/pull/147), the PR's own e2e mobile-tap test still failed — deterministically, in both this sandbox and real CI, not a flake. The `whenMouse` fix is correct and necessary, but it only addresses the self-inflicted hover-timer bug; a second, unrelated bug in `ui/src/components/ui/dropdown-menu.tsx` was the actual reason tapping a provider still failed to open its model list.

**A dead end first:** the initial hypothesis was that the app's persistent mobile floating "+" action button (`ui/src/components/layout.tsx`, `fixed ... z-40`) visually overlapped the "openai" row in the flyout and intercepted the tap. This was **wrong** — verified directly with `document.elementFromPoint()` at the exact tap coordinates, which correctly resolved to the `openai` menuitem, not the FAB (its `z-50` class already wins the stacking comparison). The FAB was never involved.

**The real root cause**, found by tracing the actual DOM mutation sequence around a tap on a provider trigger: `pointerdown` on "openai" (a `SubTrigger` two portal-levels deep — inside "Provider"'s portaled content, itself inside the root "Add to message" `DropdownMenuContent`) immediately flips the **root** `DropdownMenuContent`'s `data-state` to `closed`, before the tap's `click`/select ever fires. This is Radix's own `DismissableLayer` "is this pointerdown outside my content?" detection misfiring — and it is **not touch-specific**: the identical trace reproduces for a cold mouse click on "openai" with no prior hover. Mouse users never hit it in practice only because hovering "openai" already auto-opens its model list (via the `whenMouse`-gated hover handlers) before any click occurs, so a mouse user's click always lands on a _model_, never on the intermediate provider trigger itself. Touch has no hover, so a tap on a provider is always this exact, previously-unexercised path.

Root-caused to `DropdownMenuSubContent`'s own Portal wrapping. Radix's `MenuSubContent` does **not** portal by default — deliberately: its dismissable-layer branch/outside-click detection is built around `SubContent` staying a real DOM descendant of its parent content, not just a logical (React-tree) one. This codebase's `dropdown-menu.tsx` wraps `SubContent` in an unconditional `<Portal container={portalContainer}>` — added in `4bfd9e3` (`docs/superpowers/specs/2026-08-30-cost-modal-picker-design.md`) specifically so `rate-modal.tsx`'s native `<dialog>`-hosted picker isn't rendered invisible behind the dialog's top-layer. For `chat-input.tsx`'s case (no dialog open), `portalContainer` is `undefined`, so `<Portal container={undefined}>` still portals — to Radix's own default, `document.body`. That's the bug: even portaling to `document.body` (not just into a dialog) moves `SubContent` out of the real DOM position Radix's branch detection depends on, at exactly the 3-level nesting depth `chat-input.tsx` uses.

**Fix:** `DropdownMenuSubContent` now only wraps in a `<Portal>` when a dialog is actually open (`portalContainer` is truthy); otherwise it renders un-portaled, matching Radix's own default. `rate-modal.tsx` keeps working exactly as before (a dialog is always open there, so the condition is always true in that caller). `chat-input.tsx`'s case now renders un-portaled, and the root `DismissableLayer` correctly recognizes taps on nested provider/model items as inside its own content.

**A second-order effect, not a regression:** removing the extra portal also means the model sub-menu, when it opens via `ArrowRight`, now auto-focuses its first item immediately — matching Radix's own standard (un-portaled) behavior and typical native menu conventions. Previously (portaled), that auto-focus didn't reliably land in time, so an extra explicit `ArrowDown` was needed to reach the first item — the existing keyboard e2e test's fixed keystroke script encoded that extra step. That script now needs one fewer `ArrowDown` per nesting level; this is a keystroke-count change for the test, not a capability regression — every item remains reachable and selectable by keyboard, with one less required press.

Verified: with this fix, the previously-always-failing mobile-tap e2e test now passes (Chromium touch emulation), all existing keyboard/mouse e2e tests pass (after the keystroke-count update above), `rate-modal.tsx`'s own dialog-hosted picker unit test still passes unmodified, and new unit coverage in `ui/test/dropdown-menu-portal.test.tsx` directly encodes both halves of the conditional (portals into a dialog; renders un-portaled, as a real descendant of the root content, otherwise).

This does **not** replace section 3's `whenMouse` fix — both are required. `whenMouse` stops our own code from scheduling a premature close; this addendum stops Radix's own dismissable layer from closing the whole tree on the tap that should have opened a nested item in the first place.

---

## 4. Testing Plan

### Unit tests (`ui/test/provider-model-picker.test.tsx`, extend existing suite)

- Fire `pointerEnter`/`pointerLeave` with `{ pointerType: 'touch' }` on a provider's `SubTrigger` and `SubContent`; advance fake timers past `MODEL_SUBMENU_CLOSE_GRACE_MS`; assert the model list is still open (no close was ever scheduled). Directly encodes the fix.
- Existing/added mouse-pointerType (`{ pointerType: 'mouse' }`) cases keep passing unmodified — regression guard that desktop hover-close still works.

### `chat-input.tsx` tests

If `ui/test/chat-input.test.tsx` has pointer-driven open/close coverage for the outer "Provider" `Sub`, mirror the same touch-pointerType case there for `scheduleProviderMenuClose`.

### `dropdown-menu.tsx` tests (`ui/test/dropdown-menu-portal.test.tsx`, extended for 3a)

- Sub-content still portals into an open `<dialog>` (the `rate-modal.tsx` case) — regression guard.
- Sub-content renders un-portaled, as a real DOM descendant of the root content, when no dialog is open (the `chat-input.tsx` case) — directly encodes the 3a fix.

### E2E (`e2e/tests/chat-model-picker.spec.ts`)

No new spec file needed. Playwright's `tap()` dispatches real `pointerType: 'touch'` events under Chromium, so the existing mobile `describe` block (touch: tap through Add to message → Provider → a provider → a model) becomes a genuine regression guard for this fix — and, after the 3a fix, actually passes rather than merely running. It still cannot reproduce the original Firefox/Safari-only race (tracked separately in #145). The keyboard-only test's keystroke script was updated (one fewer `ArrowDown` per level) to match the auto-focus-on-open behavior described in 3a.

### Manual testing

Real/emulated Firefox and Safari mobile — the only way to positively confirm the Firefox/Safari-specific race is gone, since no automated engine in this repo's current config can reproduce it.

---

## 5. Files Changed

| File                                          | Change                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ui/src/components/provider-model-picker.tsx` | Guard `onPointerEnter`/`onPointerLeave` handlers to no-op for non-mouse `pointerType`   |
| `ui/src/components/chat-input.tsx`            | Same guard on the outer "Provider" `Sub`'s `onPointerEnter`/`onPointerLeave` handlers   |
| `ui/test/provider-model-picker.test.tsx`      | Add touch-pointerType no-close test; keep mouse-pointerType close test                  |
| `ui/test/chat-input.test.tsx`                 | Add equivalent touch-pointerType case if pointer-driven coverage exists there           |
| `ui/src/components/ui/dropdown-menu.tsx`      | (3a) `DropdownMenuSubContent` only portals when a dialog is open; un-portaled otherwise |
| `ui/test/dropdown-menu-portal.test.tsx`       | (3a) Add sub-content portal/no-portal coverage                                          |
| `e2e/tests/chat-model-picker.spec.ts`         | (3a) Fix keyboard test's keystroke count for the new auto-focus-on-open behavior        |

---

## 6. Out of Scope

- Re-adding a toggle-to-close-on-second-tap affordance for an already-open provider — pre-existing Radix behavior, not what #130 reports.
- Adding Firefox/WebKit projects to `e2e/playwright.config.ts` — tracked as [#145](https://github.com/tkottke90/amazing-hashbrown/issues/145).
- Any change to `rate-modal.tsx` itself — it reuses `ProviderModelPicker` directly and benefits from the 3a `dropdown-menu.tsx` fix automatically, since its own dialog-open case is unaffected (still portals, per its own unit test).
- Pen/stylus-specific handling — treated identically to touch (any non-`'mouse'` `pointerType`); no evidence it needs separate treatment.
- Upgrading the `radix-ui` package version — no confirmed upstream fix exists for this class of issue.
- Preserving the pre-3a "extra `ArrowDown` needed after opening a Sub" keyboard quirk — that was a side effect of the portaling bug, not an intentional design choice, and the corrected auto-focus-on-open behavior matches standard menu UX.
