# Cost Modal — Provider/Model Picker & Scaled Cost Input — Design

**Date:** 2026-08-30
**Status:** Approved
**Issue:** [#105 — Enhancement - Cost configuration modal UX improvements](https://github.com/tkottke90/amazing-hashbrown/issues/105)

---

## 1. Problem & Goal

The Settings → Cost rates "Add rate"/"Edit rate" modal (`ui/src/pages/settings/rate-modal.tsx`) has two usability problems:

1. **Free-text model key.** The `modelKey` field is a plain `<Input>` (`rate-modal.tsx:41,57-65`). Users must already know the `providerName/model` key convention. A mistyped key doesn't error — `seedProviderCosts()` (`api/src/services/usage.ts:43-51`) only warns to the server log and skips keys missing a `/` separator; a key with a `/` but a typo'd provider or model name silently never matches anything at cost-calculation time (`stream-handler.ts:258-261`), so the configured rate is effectively $0 with no user-visible feedback.
2. **Unit mismatch.** `inputPer1kTokens`/`outputPer1kTokens` (`CostEntrySchema`, `env.ts:39-42`) are entered per 1,000 tokens, but many providers (e.g. GLM 5.3: $1.40/M input, $4.40/M output) publish pricing per 1,000,000 tokens. Users must manually divide by 1000 before typing values in.

This design replaces the free-text field with the same provider→model drill-down already used in the chat interface, and replaces the single cost input with a number + unit-toggle control, per issue #105.

---

## 2. Config Schema Changes

`CostEntrySchema` (`api/src/config/env.ts:39-42`) gains two enum fields. The numeric fields keep their existing meaning — **always normalized to price per 1,000 tokens** — so nothing downstream that reads them changes its math:

```typescript
export const CostEntrySchema = z.object({
  inputPer1kTokens: z.number().default(0),
  inputScale: z.enum(['1k', '1M']).default('1k'),
  outputPer1kTokens: z.number().default(0),
  outputScale: z.enum(['1k', '1M']).default('1k'),
});
```

`inputScale`/`outputScale` are UI-only metadata recording which unit the value was originally entered in, so the modal can restore the correct toggle position when an entry is reopened for editing. They carry no meaning for cost calculation. Existing hand-written `config.yaml` entries have no scale fields and default to `'1k'` — correct, since their stored numbers are already per-1k regardless.

**Example — GLM 5.3 at $1.40/M input, $4.40/M output, entered via the `1M` toggle position:**

```yaml
costs:
  glm/glm-5.3:
    inputScale: 1M
    inputPer1kTokens: 0.0014 # $1.40 / 1,000,000
    outputScale: 1M
    outputPer1kTokens: 0.0044 # $4.40 / 1,000,000
```

**Not changed:**

- `stream-handler.ts:258-261`'s cost math (`(inputTokens / 1000) * rates.inputPer1kTokens + ...`) — still reads only the normalized per-1k numbers.
- `usage.ts:18-22`'s `computeHash()` — still hashes only `{ i: inputPer1kTokens, o: outputPer1kTokens }`. `inputScale`/`outputScale` are deliberately excluded from the hash: they don't affect the computed value, so a scale-only edit (toggling display unit without changing the effective price) must not spuriously close/reopen a historical cost record in `CostStore`.
- `settings.handlers.ts:306-311`'s `cost-rates` section (`get`/`patchSchema`/`write`) — `patchSchema` uses `CostEntrySchema` directly, so it picks up the new fields automatically; no handler code changes needed.
- The `costs` map's key format (`providerName/model`) — already the documented convention and already enforced informally by `usage.ts:46-49`'s warn-and-skip. This design makes the UI unable to produce anything else, closing the gap between convention and enforcement.
- Provider config's separate `ModelPricingSchema.inputPricePerM`/`outputPricePerM` (`env.ts:11-15`) — confirmed (by reading `stream-handler.ts` and `usage.ts`) to be purely a display annotation shown in the chat picker (`chat-input.tsx:261-266`), never read by cost calculation. Out of scope; not unified with `costs` by this change.

---

## 3. Frontend Components

### `ProviderModelPicker` (new — `ui/src/components/provider-model-picker.tsx`)

Extracted from the nested `DropdownMenuSub` structure in `chat-input.tsx:243-273`. Shared by both the chat input and the cost modal so there is one implementation of "drill into providers, then pick a model."

```typescript
interface ProviderModelPickerProps {
  providers: ProviderInfo[];
  activeProvider?: string;
  activeModel?: string;
  onSelect: (provider: string, model: string) => void;
  isModelHidden?: (provider: string, modelId: string) => boolean;
}
```

- Renders the existing two-level `DropdownMenuSub` → `DropdownMenuSub` structure (provider, then model), including the optional per-model pricing label (`chat-input.tsx:261-266`).
- When `isModelHidden` is provided, models it returns `true` for are filtered out of that provider's `DropdownMenuSubContent`. A provider whose every model is filtered out this way is itself omitted from the top-level provider list (nothing to drill into).
- `chat-input.tsx` is refactored to render `<ProviderModelPicker providers={providers} activeProvider={activeProvider} activeModel={activeModel} onSelect={onModelSelect} />` with no `isModelHidden`, preserving current behavior exactly.
- `rate-modal.tsx`'s Add mode renders it with `isModelHidden={(provider, modelId) => \`${provider}/${modelId}\` in costs}`.

### Dialog-portal fix in `dropdown-menu.tsx`

`DropdownMenuContent`/`DropdownMenuSubContent` (`dropdown-menu.tsx:23-43,216-230`) currently portal via the Radix default (`document.body`). `select.tsx:9-25` documents why that fails inside the modal: the cost modal uses a native `<dialog>` (`@tkottke90/preact-dialog`), whose top-layer promotion always paints above regular body-level content, so anything portaled to `document.body` renders invisible behind it, and a separate top-layer container doesn't help either since the dialog's `::backdrop` swallows pointer events for anything outside the dialog's own subtree.

Port the same `SelectPortalContext` pattern from `select.tsx` into `dropdown-menu.tsx`: track the open `<dialog>` ancestor (if any) in context and portal `DropdownMenuContent`/`DropdownMenuSubContent` into it instead of `document.body` when present. This is a prerequisite for `ProviderModelPicker` to work inside `RateModal` at all; `chat-input.tsx`'s existing (non-dialog) usage is unaffected since there's no dialog ancestor to redirect into.

### `ScaleToggle` (new — `ui/src/components/ui/scale-toggle.tsx`)

A two-option exclusive control styled as a segmented button pair (`1k` / `1M`), built on Radix `RadioGroup` (already available via the `radix-ui` package) rather than `Switch` — this is a labeled choice between two named options, not an on/off flag, and `RadioGroup` gives correct `role="radiogroup"`/`role="radio"` semantics and arrow-key navigation between the two items for free.

```typescript
function ScaleToggle({
  value,
  onChange,
  ...
}: {
  value: '1k' | '1M';
  onChange: (v: '1k' | '1M') => void;
}): JSX.Element
```

Rendered as `RadioGroupPrimitive.Root` containing two `RadioGroupPrimitive.Item`s, styled to look like a connected button pair (similar visual weight to `button.tsx`'s `size="sm"` variant) with the selected item highlighted, rather than Radix's default radio-dot appearance.

### `ScaledCostInput` (new — `ui/src/components/ui/scaled-cost-input.tsx`)

Composes `Input` + `ScaleToggle` per the requested layout:

```
label label label
input input toggle
```

```typescript
interface ScaledCostInputProps {
  id: string;
  label: string;
  per1kValue: number; // always normalized, per-1k
  scale: '1k' | '1M';
  onChange: (per1kValue: number, scale: '1k' | '1M') => void;
}
```

Internally displays `per1kValue * (scale === '1M' ? 1000 : 1)` in the number field. On number input, converts the displayed value back to per-1k before calling `onChange`. On toggle change, re-displays the *same* underlying `per1kValue` converted to the new unit (switching units alone doesn't change the effective price) and calls `onChange` with the unchanged `per1kValue` and the new `scale`.

Grid implementation:

```css
.scaled-cost-input {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  grid-template-areas:
    'label label label'
    'input input toggle';
  gap: 0.375rem;
}
```

---

## 4. `rate-modal.tsx` Behavior

### Add mode

- `ProviderModelPicker` replaces the free-text `modelKey` `<Input>`. Selecting a provider/model sets `modelKey = "${provider}/${model}"` (matching the format `usage.ts` already expects).
- `isModelHidden` filters out any `provider/model` combination already present as a key in `costs`, per the model-level filtering rule: a provider with some but not all models costed still appears, showing only its remaining models.
- Two `ScaledCostInput`s (input cost, output cost) replace the two plain number `<Input>`s. Each defaults to `per1kValue: 0, scale: '1k'`.

### Edit mode

- The provider/model is shown as static read-only text (e.g. the current `modelKey` string), not the picker component — the key cannot change after creation, so there's no interactive picker to render or disable.
- Both `ScaledCostInput`s remain fully editable, initialized from the entry's stored `inputPer1kTokens`/`inputScale` and `outputPer1kTokens`/`outputScale`. The toggle can be flipped at any time; per `ScaledCostInput`'s contract, this only changes the *displayed* unit and the stored `scale`, never the underlying price, unless the user also edits the number.

### Submission

`RateForm.handleSubmit` (`rate-modal.tsx:45-52`) is otherwise unchanged: it still calls `onSave(modelKey, entry)` with `entry` now including all four `CostEntry` fields, then closes the dialog. `CostRatesPanel.handleAddRate`/`handleEditRate` (`cost-rates-panel.tsx:26-32`) require no changes — they already just merge whatever `entry` they're given into the `costs` map. `cost-rates-panel.tsx:71`'s summary line (`In: $x/1k · Out: $y/1k`) is updated to show the value in its stored scale's unit for readability (e.g. `In: $1.40/1M`), computed the same way `ScaledCostInput` does.

---

## 5. Error Handling

- With no free-text entry point for the model key, the silent-mismatch failure mode described in the issue is eliminated by construction — every key the modal can produce is one the picker's own data source (`GET /api/v1/providers`) confirms exists.
- `ScaledCostInput`'s number field keeps existing validation (`type="number"`, `min="0"`, `required`) unchanged. The toggle introduces no new validation surface — it only affects unit conversion, and both states are always valid.
- If `GET /api/v1/providers` returns no providers (or hasn't loaded yet), the Add button in `CostRatesPanel` should be disabled with a short explanatory label ("Loading providers…" / "No providers configured"), matching how `chat-input.tsx:240` already guards its own picker on `providers && providers.length > 0`.

---

## 6. Testing

- Unit tests for `ScaledCostInput`: 1k↔1M round-trip conversion (entering a value in one unit, toggling, confirming the displayed number updates and the emitted `per1kValue` is unchanged); edit-mode initialization reflects a stored `scale`.
- Unit tests for `ProviderModelPicker`'s `isModelHidden` filtering: a model hidden when costed, a provider hidden when every one of its models is costed, a provider with a mix of costed/uncosted models still shown with only the uncosted ones selectable.
- Update/extend `ui/test/settings-cost-rates-panel.test.tsx` to cover the new picker-driven Add flow (selecting provider/model instead of typing) and the scale-aware summary line.
- Extend `e2e/tests/settings-sections.spec.ts` / `settings-save-contracts.spec.ts` fixtures if the `CostEntry` shape used there needs the new fields for type-correctness (they can omit them and rely on the schema default of `'1k'`).
- Add or extend an e2e test exercising the full modal flow: open Add rate, drill into a provider's model via the picker, enter a value with the `1M` toggle selected, save, and confirm the persisted `config.yaml` (or PATCH body) has the correct normalized `inputPer1kTokens` and `inputScale: '1M'`.
- No change expected to `e2e/tests/001-ChatInterface.spec.ts` beyond updating selectors if `ProviderModelPicker`'s extraction changes any DOM structure/test-id used there — the rendered menu content (provider → model → pricing label) is unchanged.

---

## 7. Files Changed

| File | Change |
| --- | --- |
| `api/src/config/env.ts` | Add `inputScale`/`outputScale` to `CostEntrySchema` |
| `ui/src/components/provider-model-picker.tsx` | New — shared provider→model drill-down, extracted from `chat-input.tsx` |
| `ui/src/components/chat-input.tsx` | Use `ProviderModelPicker`; no behavior change |
| `ui/src/components/ui/dropdown-menu.tsx` | Port dialog-portal-target fix from `select.tsx` |
| `ui/src/components/ui/scale-toggle.tsx` | New — Radix `RadioGroup`-based `1k`/`1M` segmented control |
| `ui/src/components/ui/scaled-cost-input.tsx` | New — number input + `ScaleToggle`, normalizes to per-1k |
| `ui/src/pages/settings/rate-modal.tsx` | Replace free-text model input with `ProviderModelPicker` (Add) / static text (Edit); replace plain cost inputs with `ScaledCostInput` |
| `ui/src/pages/settings/cost-rates-panel.tsx` | Update rate summary line to display in the entry's stored scale |
| `docs/App-Docs/configuration.md` | Document `inputScale`/`outputScale` in the Cost Rates schema table |

---

## 8. Out of Scope

- Unifying `costs` with the provider config's `ModelPricingSchema.inputPricePerM`/`outputPricePerM` (confirmed unrelated — display-only annotation, not read by cost calculation).
- Any change to how `stream-handler.ts` computes cost, or to `CostStore`'s historical-rate schema.
- A generic reusable "radio button group" design-system component beyond the specific `1k`/`1M` `ScaleToggle` needed here.
- Deleting/renaming existing cost entries whose key doesn't match the `provider/model` convention (e.g. hand-edited `config.yaml` entries) — they continue to work via `stream-handler.ts`'s lookup as before; this design only changes how *new* keys are produced by the UI.
