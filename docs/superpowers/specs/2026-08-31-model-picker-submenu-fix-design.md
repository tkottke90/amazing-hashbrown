# Model Picker Sub-Menu Fix — Design

**Date:** 2026-08-31
**Status:** Approved
**Issue:** [#113 — Bug: Model sub-menu closes before user can select a model in wiki chat](https://github.com/tkottke90/amazing-hashbrown/issues/113)

---

## 1. Problem & Goal

The provider/model switcher shipped in the [provider/model switcher design](./2026-08-04-provider-model-switcher-design.md) nests the model picker three levels deep inside the chat input's "Add to message" menu: **Add to message → Provider → `<provider name>` → `<model>`**. In production, the innermost sub-menu (the model list) closes before the user can move the cursor into it or keyboard-navigate into it, making it effectively impossible to switch models. This is currently reported against the wiki chat view but affects every chat surface built on the shared `ChatInput` component, since they all share the same menu structure.

Goal: make model selection reliable via both mouse and keyboard, without changing the menu's visual structure or requiring users to relearn the interaction.

---

## 2. Root Cause

The provider→model drill-down is implemented once, in `ProviderModelPicker` (`ui/src/components/provider-model-picker.tsx`), and reused by two callers:

| Caller                                                                                                                        | Nesting depth                                                | Reported broken? |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| `chat-input.tsx` — "Add to message" menu (wraps `ProviderModelPicker` in an extra "Provider" `DropdownMenuSub`)               | 3 levels (`Content` → `Sub` "Provider" → `Sub` per-provider) | Yes              |
| `rate-modal.tsx` — Settings → cost rates "Add rate" modal (mounts `ProviderModelPicker` directly under `DropdownMenuContent`) | 2 levels (`Content` → `Sub` per-provider)                    | No               |

Both callers render the _same_ component; the only difference is nesting depth. This matches several open, unresolved upstream Radix issues describing `DropdownMenu.Sub`/`SubContent` closing prematurely or inconsistently once menus nest beyond a single `Sub` level (e.g. [radix-ui/primitives#3761](https://github.com/radix-ui/primitives/issues/3761), [#2652](https://github.com/radix-ui/primitives/issues/2652)) — there is no released fix to upgrade into.

The project's own test suite already flags this: `ui/test/chat-input.test.tsx` (lines 110–115) notes that "a third level of nested Radix submenu-in-a-submenu isn't reliably openable via jsdom's synthetic events."

There is no custom mouseleave/blur/timer code causing this — Radix's own internal pointer/grace-area timing is what breaks down at this depth, and no root cause deeper than "Radix's nested-`Sub` timing is unreliable past one level" is confirmed or fixable upstream.

---

## 3. Fix Design

**Scope:** `ui/src/components/provider-model-picker.tsx` only. No change to `chat-input.tsx`, `rate-modal.tsx`, or `ui/src/components/ui/dropdown-menu.tsx` — the menu stays exactly as deep as it is today.

Convert the per-provider `DropdownMenuSub` from Radix's uncontrolled (hover-timing-driven) mode to **app-controlled** mode, so the decision of when to open/close no longer depends on Radix's own depth-sensitive internal timing:

- One shared `openProvider: string | null` state and one shared close-timer live in `ProviderModelPicker`.
- `onPointerEnter` / `onFocus` on a provider's `SubTrigger` _or_ its `SubContent` cancels any pending close and immediately sets `openProvider` to that provider. Moving the cursor into the content — even diagonally, even if Radix's internal logic would otherwise race to close it — keeps it open.
- `onPointerLeave` on either element, or Radix itself calling `onOpenChange(false)`, does **not** close immediately. It schedules a close after a short grace delay (~200ms). If the pointer or focus re-enters either boundary before the delay elapses, the scheduled close is cancelled.
- Radix's own "close this" signal is treated as a suggestion, not a command: even when Radix's internal timing decides prematurely to close, the app doesn't act on it synchronously — it only starts the same grace window a real pointer-leave would trigger. This neutralizes the specific premature-close race without needing to know exactly why Radix's timing is wrong at this depth.
- Selecting a model still closes the entire menu tree (Radix's default close-on-select, unchanged) — `ProviderModelPicker` unmounts, so any pending grace timer becomes moot.
- Switching directly between sibling providers (e.g. moving from "openai"'s trigger to "ollama"'s trigger without entering either's content) reassigns the single `openProvider` state immediately — no stuck-open or dead-zone state.
- Keyboard navigation (`ArrowRight`/`ArrowLeft`/`Enter`, already handled by Radix and already covered by the existing `openSubmenu()` test helper) is left as-is; `onFocus` additionally keeps the controlled state open when focus lands in either the trigger or content, so tabbing/arrow-navigating doesn't race a stale close timer the way hover currently does.

Because the fix lives inside the shared component rather than either caller, it applies uniformly to every current and future consumer of `ProviderModelPicker` — there is nothing to duplicate the fix into, and no risk of leaving a second, differently-nested instance still broken.

### 3a. Addendum — real-browser manual testing found two more gaps

The above was validated by unit tests and by e2e/manual checks driven through Playwright, all of which passed — but real manual testing in a browser still showed the sub-menu closing, for both mouse and keyboard. Two gaps existed that automated testing had missed:

1. **`chat-input.tsx`'s scope claim above was wrong.** The outer "Provider" `DropdownMenuSub` (one level up, still Radix-uncontrolled) also needed the same controlled-open treatment. With only the inner per-provider `Sub` controlled, a genuine keyboard `ArrowRight` on a provider (e.g. "openai") collapsed the _entire_ menu tree back to the root and threw focus out to `<body>` — the outer Sub's own uncontrolled bookkeeping got corrupted by the inner Sub's controlled re-render. `chat-input.tsx` now has its own `providerMenuOpen` signal, close-timer, and the same `onPointerEnter`/`onFocus`/`onPointerLeave`/`onOpenChange` wiring as `ProviderModelPicker`, sharing `MODEL_SUBMENU_CLOSE_GRACE_MS`.
2. **Preact batches renders asynchronously in a real browser; Testing Library's `act()` does not.** Radix runs synchronous continuation code immediately after calling `onOpenChange(true)` — e.g. moving focus onto the first item inside the newly-opened content. In the unit and e2e tests, `act()` (used internally by `fireEvent`) forces a synchronous flush after every dispatched event, so the DOM always reflected the new `open` state by the time Radix's follow-up code ran. In a real browser there is no such forced flush: Preact's normal batching meant Radix's synchronous code sometimes ran _before_ the render landed, found the not-yet-mounted content, and aborted by closing everything. Both `openProviderNow` (in `ProviderModelPicker`) and `openProviderMenuNow` (in `chat-input.tsx`) now wrap their signal write in `flushSync` (from `preact/compat`) to force the DOM to reflect the new open state synchronously, before returning control to Radix.

Root-caused via a throwaway diagnostic script that logged `document.activeElement` after each real (not locator-forced) keyboard event against the running dev server, plus an isolated comparison against `rate-modal.tsx`'s 1-Sub-level usage (which worked correctly, pointing at the _interaction between_ the two Sub levels rather than the controlled-Sub mechanism itself). The committed e2e spec (`e2e/tests/chat-model-picker.spec.ts`) was also rewritten to use only `page.keyboard.press()` against whatever currently has focus — the original version used `locator.press()` on specific target elements, which programmatically re-focuses each element and bypasses Radix's roving-tabindex focus travel, silently hiding this exact regression.

### 3b. Addendum — still broken in real usage; the actual root cause

Even after 3a, the reporter found the bug reproducing again in real manual testing (both Chrome and Firefox), specifically when lingering on or moving the cursor _within_ an already-open model list rather than just arriving at it. Two things were checked and ruled out first:

- **Reverting to fully uncontrolled, unmodified Radix** (matching the shadcn/Radix docs' nested-submenu example exactly, including confirming `DropdownMenuSubContent` already wraps in a `Portal` — it does, just inside the shared `dropdown-menu.tsx` wrapper rather than written explicitly at each call site) **reproduces the identical bug.** This was verified with the same real-keyboard diagnostic technique from 3a: pressing `ArrowRight` on a focused provider still collapses the entire menu and throws focus to `<body>`. The app-controlled approach was not "over-engineering" masking a simpler underlying fix — pure Radix has the same defect at this nesting depth.
- Firefox was suspected as engine-specific, but the reporter also reproduced it on Chrome (only the outer "Provider" and model sub-menu closed there, not the root menu) — ruling out a single-engine quirk.

**Actual root cause:** a provider's own model list, rendered by `ProviderModelPicker`, is a **separately-portaled DOM subtree** — it is not a DOM descendant of `chat-input.tsx`'s outer "Provider" `Sub`'s own trigger/content, even though it is logically nested inside it. The moment the cursor moves off "Provider"'s own trigger/content elements and into a provider's model list, "Provider"'s own `onPointerLeave` fires and schedules 3a's grace-delay close — correctly, from "Provider"'s own point of view, since nothing tells it a descendant menu is what the cursor moved into. If the cursor spends more than the ~200ms grace window inside the model list (exactly what happens when a user actually reads model names before picking one, and exactly what none of the automated tests had done — they moved and clicked in well under 200ms), that scheduled close fires and unmounts "Provider," cascading down and killing the model list the user was actively using underneath it.

**Fix:** `ProviderModelPicker` gained an `onAnyOpenChange?: (isOpen: boolean) => void` prop, called the moment any provider's model list opens (`true`) and once it actually closes after its own grace delay elapses with no re-entry (`false`) — never on every intermediate pointer event. `chat-input.tsx` wires this to force "Provider" open (and cancel any pending close) the instant a child opens, and — critically — tracks a persistent `childMenuOpen` signal that gates `scheduleProviderMenuClose`: while a child is open, "Provider"'s own direct `onPointerLeave` handlers (which keep firing every time the cursor moves around inside the already-open, separately-portaled child) are no-ops instead of re-arming a close each time. Only once the child itself has genuinely closed does "Provider" get its own chance to close on the same grace timer. This was verified by reproducing the exact failure (mouse arrives at a model, lingers ~300ms, then moves to a sibling model within the same list) directly against a running dev server in both Firefox and Chromium (Firefox was downloaded via `npx playwright install firefox` for this — not part of the repo's pre-installed Chromium), confirming the sequence failed before this change and passed reliably after, in both engines, across repeated runs — while a genuine "move away entirely" still closes the menu correctly in both.

---

## 4. Testing Plan

### Unit tests (`ui/test/provider-model-picker.test.tsx`, Preact Testing Library + fake timers)

- Pointer enters a provider's `SubTrigger` → content opens; pointer then leaves the trigger and enters the `SubContent` within the grace window → content stays open, model is selectable. (Directly covers the reported failure.)
- Pointer leaves both trigger and content and never returns → after the grace delay, content closes.
- Switching directly from one provider's trigger to a sibling's trigger closes the first and opens the second with no stuck-open state.
- Existing `openSubmenu()` (focus + click + `ArrowRight`) tests keep passing unmodified, confirming keyboard/click paths aren't disturbed.

### E2E test (new: `e2e/tests/chat-model-picker.spec.ts`)

Follows the existing suite's conventions (`TestSuite` metadata block citing issue #113, `page.route()` mocking, per `wiki-graph.spec.ts` and `chat-send.spec.ts`). Runs against the **base chat page** (`page.goto('/')`, the same page `chat-send.spec.ts` uses), not the wiki view — same `ChatInput` component and `/api/v1/providers` fetch, simpler setup (no domain/graph mocking needed).

This gives real-browser, real-Radix-event coverage of the keyboard path, which is not reliable to simulate in jsdom:

1. Mock `/api/v1/providers` with 2+ providers, 2+ models each.
2. Keyboard-only path: `Tab` to the "Add to message" trigger → `Enter`/`Space` to open → arrow down to "Provider" → `ArrowRight` to open the provider list → arrow down to a provider → `ArrowRight` to open its model list → arrow down to a model → `Enter` to select.
3. Assert `[data-slot="model-chip"]` shows the selected model id — proof the fix works end-to-end, not just that a submenu rendered.
4. Repeat selecting a different provider's model, covering the sibling-switch case.

Added to `npm run test:ci` alongside the rest of the suite, becoming the durable regression test for issue #113.

### Mouse test (added in 3b: `chat-model-picker.spec.ts`, "mouse: lingering in and moving within an open model list does not close the menu")

Originally scoped as manual-only (see the removed rationale below), but 3b's actual root cause — closing during a lingering/within-content move, not just a fast arrival — turned out to reproduce reliably enough to automate once the test moved the cursor in discrete steps with real waits between them (matching realistic human cursor speed) rather than a single fast synthetic move: hover into an open model list, wait ~300ms, move to a sibling model within the same list, click it, assert the chip updates. This is now part of the same committed spec and CI run.

~~Manual verification~~ — superseded: mouse interaction is now covered by the automated test above.

---

## 5. Files Changed

| File                                          | Change                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ui/src/components/provider-model-picker.tsx` | Convert per-provider `DropdownMenuSub` to app-controlled open state with shared hover/focus boundary + grace-delay close |
| `ui/test/provider-model-picker.test.tsx`      | Add tests for diagonal pointer movement, no-return close, and sibling-switch behavior                                    |
| `e2e/tests/chat-model-picker.spec.ts`         | New — keyboard-only regression test for issue #113 against the base chat page                                            |

---

## 6. Out of Scope

- The graph-view.tsx "Open in editor" hover card bug (same bug _class_ — an isolated `mouseleave` with no shared hover boundary — but a separate, hand-rolled D3 component, not a Radix menu). Tracked as a follow-up, not fixed here.
- Any change to the menu's visual structure or the number of nesting levels.
- Upgrading the `radix-ui` package version (checked upstream; no confirmed fix exists to upgrade into for this class of nested-`Sub` bug).
- Reverting to fully uncontrolled Radix (tried and ruled out in 3b — reproduces the same bug).
