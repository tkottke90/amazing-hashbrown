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

### Manual verification

Mouse/diagonal-hover interaction is verified manually (dev server + Chromium) rather than automated — real cursor-path timing is not reliably assertable even in Playwright. Repro steps: open the base chat, click "Add to message," hover "Provider," hover a provider, move the mouse diagonally into the model sub-menu, click a model, confirm the model chip updates.

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
- Automated (Playwright) coverage of mouse/diagonal-hover movement — verified manually only.
