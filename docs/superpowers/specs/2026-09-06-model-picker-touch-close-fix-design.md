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

## 4. Testing Plan

### Unit tests (`ui/test/provider-model-picker.test.tsx`, extend existing suite)

- Fire `pointerEnter`/`pointerLeave` with `{ pointerType: 'touch' }` on a provider's `SubTrigger` and `SubContent`; advance fake timers past `MODEL_SUBMENU_CLOSE_GRACE_MS`; assert the model list is still open (no close was ever scheduled). Directly encodes the fix.
- Existing/added mouse-pointerType (`{ pointerType: 'mouse' }`) cases keep passing unmodified — regression guard that desktop hover-close still works.

### `chat-input.tsx` tests

If `ui/test/chat-input.test.tsx` has pointer-driven open/close coverage for the outer "Provider" `Sub`, mirror the same touch-pointerType case there for `scheduleProviderMenuClose`.

### E2E (`e2e/tests/chat-model-picker.spec.ts`)

No new spec file needed. Playwright's `tap()` dispatches real `pointerType: 'touch'` events under Chromium, so the existing mobile `describe` block (touch: tap through Add to message → Provider → a provider → a model) becomes a genuine regression guard for this fix, even though it cannot reproduce the original Firefox/Safari-only race (tracked separately in #145).

### Manual testing

Real/emulated Firefox and Safari mobile — the only way to positively confirm the Firefox/Safari-specific race is gone, since no automated engine in this repo's current config can reproduce it.

---

## 5. Files Changed

| File | Change |
| --- | --- |
| `ui/src/components/provider-model-picker.tsx` | Guard `onPointerEnter`/`onPointerLeave` handlers to no-op for non-mouse `pointerType` |
| `ui/src/components/chat-input.tsx` | Same guard on the outer "Provider" `Sub`'s `onPointerEnter`/`onPointerLeave` handlers |
| `ui/test/provider-model-picker.test.tsx` | Add touch-pointerType no-close test; keep mouse-pointerType close test |
| `ui/test/chat-input.test.tsx` | Add equivalent touch-pointerType case if pointer-driven coverage exists there |

---

## 6. Out of Scope

- Re-adding a toggle-to-close-on-second-tap affordance for an already-open provider — pre-existing Radix behavior, not what #130 reports.
- Adding Firefox/WebKit projects to `e2e/playwright.config.ts` — tracked as [#145](https://github.com/tkottke90/amazing-hashbrown/issues/145).
- Any change to `rate-modal.tsx` — it reuses `ProviderModelPicker` directly and benefits from this fix automatically.
- Pen/stylus-specific handling — treated identically to touch (any non-`'mouse'` `pointerType`); no evidence it needs separate treatment.
- Upgrading the `radix-ui` package version — no confirmed upstream fix exists for this class of issue.
