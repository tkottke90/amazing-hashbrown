# Model Picker Touch Sub-Menu Close Fix — Implementation Plan

**Date:** 2026-09-06
**Spec:** [`docs/superpowers/specs/2026-09-06-model-picker-touch-close-fix-design.md`](../specs/2026-09-06-model-picker-touch-close-fix-design.md)
**Issue:** [#130](https://github.com/tkottke90/amazing-hashbrown/issues/130)

Each step is a self-contained unit: implementation + its own tests. Run `npm run lint`, `npx prettier --check .`, and `npm test` (UI workspace) after each step before moving to the next.

---

## Step 1 — `whenMouse` guard in `provider-model-picker.tsx`

In `ui/src/components/provider-model-picker.tsx`, add a small helper mirroring Radix's own internal `whenMouse` (verified in `radix-ui`'s `menu.tsx` source — see the design doc's root-cause section), placed near `MODEL_SUBMENU_CLOSE_GRACE_MS` and exported so `chat-input.tsx` can reuse it in Step 2:

```typescript
// Mirrors Radix's own internal `whenMouse` guard on its pointer-hover
// handlers (MenuItemImpl/MenuSubTrigger/MenuContentImpl in radix-ui's
// menu.tsx) — hover-driven open/close state must never react to touch or
// pen, only real mouse hover. Our own onPointerEnter/onPointerLeave below
// never had this guard, which is the root cause of issue #130.
export function whenMouse<E extends { pointerType: string }>(
  handler: (event: E) => void,
): (event: E) => void {
  return (event) => {
    if (event.pointerType === 'mouse') handler(event);
  };
}
```

Apply it to all four existing hover handlers on the per-provider `Sub` (lines 153-165 today):

```typescript
<DropdownMenuSubTrigger
  className={p.name === activeProvider ? 'font-semibold' : undefined}
  onPointerEnter={whenMouse(() => openProviderNow(p.name))}
  onFocus={() => keepOpenOnFocus(p.name)}
  onPointerLeave={whenMouse(() => scheduleProviderClose(p.name))}
>
  {p.name}
</DropdownMenuSubTrigger>
<DropdownMenuSubContent
  onPointerEnter={whenMouse(() => openProviderNow(p.name))}
  onFocus={() => keepOpenOnFocus(p.name)}
  onPointerLeave={whenMouse(() => scheduleProviderClose(p.name))}
>
```

`onFocus`/`onOpenChange`/everything else in the file is unchanged.

**Tests** (extend `ui/test/provider-model-picker.test.tsx`, new describe block after the existing `'ProviderModelPicker — hover-open grace window (issue #113)'` block — same `beforeEach`/`afterEach` fake-timer setup):

```typescript
describe('ProviderModelPicker — touch never schedules a hover-close (issue #130)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('a touch pointerLeave never schedules a close', () => {
    renderPicker();
    const trigger = screen.getByText('openai');

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    fireEvent.pointerLeave(trigger, { pointerType: 'touch' });
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });

    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('a touch pointerEnter still lets the model be opened and selected via click (Radix\'s own tap-to-open path)', () => {
    const { onSelect } = renderPicker();
    openSubmenu(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o'));
    expect(onSelect).toHaveBeenCalledWith('openai', 'gpt-4o');
  });
});
```

The existing `'issue #113'` describe block's `fireEvent.pointerEnter`/`pointerLeave` calls have no explicit `pointerType` — confirm jsdom's `PointerEvent` defaults `pointerType` to `''` (not `'mouse'`), which `whenMouse` would treat as non-mouse and break those tests. If so, update those existing calls to pass `{ pointerType: 'mouse' }` explicitly (this is a required fix to keep the #113 regression tests meaningful under the new guard, not an unrelated change — call this out in the commit message).

Run `npm test --workspace ui -- --testPathPattern provider-model-picker` before moving on.

---

## Step 2 — Apply the same guard in `chat-input.tsx`

In `ui/src/components/chat-input.tsx`:

- Import `whenMouse` alongside the existing `ProviderModelPicker, MODEL_SUBMENU_CLOSE_GRACE_MS` import from `@/components/provider-model-picker`.
- Wrap the outer "Provider" `Sub`'s four hover handlers (currently lines 473-483):

```typescript
<DropdownMenuSubTrigger
  onPointerEnter={whenMouse(openProviderMenuNow)}
  onFocus={keepProviderMenuOpenOnFocus}
  onPointerLeave={whenMouse(scheduleProviderMenuClose)}
>
  Provider
</DropdownMenuSubTrigger>
<DropdownMenuSubContent
  onPointerEnter={whenMouse(openProviderMenuNow)}
  onFocus={keepProviderMenuOpenOnFocus}
  onPointerLeave={whenMouse(scheduleProviderMenuClose)}
>
```

`openProviderMenuNow`/`scheduleProviderMenuClose` currently take no parameters and ignore the event `whenMouse` passes through — no signature change needed there.

**Tests**: `ui/test/chat-input.test.tsx` has no existing pointer-hover-grace coverage for the outer "Provider" `Sub` (unlike `provider-model-picker.test.tsx`) — add a new one, reusing this file's own `firePointerDown`/`openSubmenu` helpers:

```typescript
describe('ChatInput — Provider sub-menu touch never schedules a hover-close (issue #130)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('a touch pointerLeave on the outer Provider trigger never schedules a close', () => {
    render(
      <ControlledChatInput
        providers={[{ name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }] }]}
      />,
    );
    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    const providerTrigger = screen.getByText('Provider');

    fireEvent.pointerEnter(providerTrigger, { pointerType: 'mouse' });
    expect(screen.getByText('openai')).toBeInTheDocument();

    fireEvent.pointerLeave(providerTrigger, { pointerType: 'touch' });
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });

    expect(screen.getByText('openai')).toBeInTheDocument();
  });
});
```

Import `act` from `preact/test-utils` and `MODEL_SUBMENU_CLOSE_GRACE_MS` from `@/components/provider-model-picker` at the top of the test file (neither is currently imported there).

Run `npm test --workspace ui -- --testPathPattern chat-input` before moving on.

**Checkpoint:** both app-controlled `Sub` layers now ignore touch-originated hover events identically. This is the complete code fix for #130 — Steps 3-4 are verification only.

---

## Step 3 — Strengthen the e2e mobile test with a lingering pause

In `e2e/tests/chat-model-picker.spec.ts`'s mobile `describe` block (touch: tap through Add to message → Provider → a provider → a model, currently lines 197-249), the existing 250ms waits already approximate a hesitant tap. Add one more deliberate pause mirroring the mouse "linger" test above it (which is what caught the real #113 regression in 3b): after the model list appears, wait ~300ms before tapping the model, to more closely match a real user reading model names before tapping one.

```typescript
const firstModel = page.getByRole('menuitemcheckbox', { name: 'gpt-4o', exact: true });
await expect(firstModel).toBeVisible();

await page.waitForTimeout(250);
await expect(firstModel).toBeVisible();

// Linger, matching the mouse test's "read the model list before tapping"
// scenario — a real user's tap isn't instantaneous.
await page.waitForTimeout(300);
await expect(firstModel).toBeVisible();
await firstModel.tap();
```

This runs under Chromium's touch emulation (real `pointerType: 'touch'` events), so it becomes a genuine regression guard for the Step 1/2 fix even though it can't reproduce the original Firefox/Safari-only race — that gap is tracked separately in #145.

Run `npm run test:e2e -- chat-model-picker` (or this repo's equivalent Playwright filter) before moving on.

---

## Step 4 — Manual verification (Firefox & Safari mobile)

Per the design doc, no automated engine here can reproduce the original Firefox/Safari-specific race, so this step is required before closing #130:

- On real or emulated Firefox mobile and Safari mobile, open the model picker in the chat input (`Add to message → Provider`), tap a provider, and tap a model in the resulting sub-menu — confirm the sub-menu stays open long enough and the model is selected.
- Repeat selecting a model from a second, sibling provider.
- Deliberately pause (read the model names) before tapping, matching the e2e "linger" scenario from Step 3 — confirm no premature close.
- Confirm desktop mouse and keyboard selection (already covered by the existing e2e suite) still work — no regression.

---

## Step 5 — Final pass

- `npm run lint`, `npx prettier --check .`, `npm test` (full suite) from repo root.
- Confirm the e2e suite (`npm run test:e2e` or repo equivalent) passes end-to-end, not just the filtered chat-model-picker run from Step 3.

---

## Explicitly not touched by this plan

Everything listed in the spec's §6: no toggle-to-close-on-second-tap affordance, no changes to `rate-modal.tsx` (benefits automatically via the shared `whenMouse`-guarded `ProviderModelPicker`), no Firefox/WebKit Playwright projects (tracked in #145), no pen/stylus-specific handling, no `radix-ui` version change.
