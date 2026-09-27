# Favorite Models — Design

Issue: [tkottke90/amazing-hashbrown#137](https://github.com/tkottke90/amazing-hashbrown/issues/137)

## Problem

The chat model picker is a provider → model drill-down. For a router provider
(one endpoint fronting many models, e.g. DigitalOcean Serverless Inference)
that means scrolling through dozens of models every time to reach the two or
three actually used.

## Goal

Let a user pin specific provider/model pairs as favorites — editable in
`config.yaml` or on the Model providers settings page — and select them from a
flat list at the top of the chat input's Provider sub-menu.

## Non-goals

- Reordering favorites (entries append; reorder by editing `config.yaml`).
- Per-favorite labels/aliases.
- Hiding non-favorite models from the per-provider lists.
- Automatic pruning of stale favorites.

## Decisions

| #   | Decision                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Stored as a top-level ordered array `favoriteModels: [{ provider, model }]` — not a `Record`. A favorite carries no value, and order is user-meaningful.                                                        |
| 2   | With zero favorites, the chat menu shows **no** Favorites section at all (no empty-state, no Configure link). Discovery is via Settings only.                                                                   |
| 3   | Favorites render as flat items **inside** the existing Provider sub-menu, above the per-provider entries. No new nested sub-menu (avoids reintroducing the #113/#130 hover/close-timing bugs).                  |
| 4   | Stale favorites are never deleted automatically. Backend rejects unknown **providers** on PATCH; models are not validated (network-dependent). Settings shows an "Unavailable" badge; chat hides stale entries. |
| 5   | Favorites get their own card on the Model providers panel. The Default provider card is left unchanged (the issue's "Provider settings" merge is dropped).                                                      |
| 6   | Settings-page saves persist to `config.yaml` via the existing `mergeConfigYaml`; the key is documented so it can be hand-edited.                                                                                |

## 1. Config and backend

### `config.yaml`

```yaml
defaultProvider: local
favoriteModels:
  - provider: do-serverless
    model: llama3.3-70b-instruct
  - provider: local
    model: qwen3:14b
```

### Schema — `api/src/config/env.ts`

- `FavoriteModelSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) })`,
  exported type `FavoriteModel`.
- Root config schema gains `favoriteModels: z.array(FavoriteModelSchema).default([])`.
- `env.favoriteModels` getter. Unlike `env.costs` (whose `catch` returns `{}`,
  so one bad entry drops the whole section), this getter reads the raw array
  and keeps only entries that pass `FavoriteModelSchema.safeParse`, so one
  malformed hand-edited entry doesn't discard the rest. A non-array value
  yields `[]`.
- Well-formed entries referencing a provider that doesn't exist are loaded
  as-is — they are never a startup error.

### Settings API — `api/src/routes/v1/settings.handlers.ts`, `model-providers` slug

- `ModelProvidersSettings` type and `get()` gain `favoriteModels` (unfiltered).
- `patchSchema` gains `favoriteModels: z.array(FavoriteModelSchema).optional()`.
- Validation (returns a field error keyed `favoriteModels`, same error shape as
  existing section validation failures):
  - Every favorite's `provider` must be the `name` of a provider in the
    effective post-patch list — the incoming `providers` if present in the
    body, otherwise `env.providers`.
  - No duplicate `provider`+`model` pairs.
  - If the body changes `providers` but not `favoriteModels`, the stored
    favorites are validated against the incoming providers too, so removing
    or renaming a provider through the API can't silently orphan favorites.
    (The settings UI can't rename providers — the Name field is disabled in
    edit mode — so this guards direct API use and hand-edits.)
  - Consequence: the panel PATCHes the full form, so a hand-edited favorite
    naming a nonexistent provider blocks saving the panel until it is removed.
    This is intended — the field error surfaces under the Favorites card, and
    that row already shows the Unavailable badge, so the fix is one click.
    Favorites with a valid provider but a missing model never block a save.
- `write()` replaces the whole `favoriteModels` array when present.

### Chat data — `GET /api/v1/providers` (`api/src/routes/v1/providers.route.ts`)

- Response gains `favoriteModels`, filtered to entries whose provider exists
  and whose model is in that provider's live model list (already computed by
  this handler — no extra network calls). Order preserved.

### Backend tests

- `settings.handlers.test.ts`: GET includes `favoriteModels`; PATCH round-trips
  to `config.yaml`; unknown provider rejected; duplicate rejected; validation
  uses incoming `providers` when present; changing `providers` alone
  re-validates stored favorites.
- `env` getter: malformed entry dropped while valid siblings survive; missing
  key → `[]`.
- Providers route: stale provider and stale model entries filtered out; order
  preserved; empty → `[]`.

## 2. Settings UI

### `ui/src/pages/settings/favorite-model-modal.tsx` (new)

- Add-only modal modelled on `rate-modal.tsx`: one provider/model picker field
  via `useProviderModelPicker`, Cancel + "Add favorite" (disabled until a model
  is picked).
- `isModelHidden` hides pairs already in the (unsaved) favorites list.
- Model data comes from the `providers` signal (`GET /api/v1/providers`), so a
  provider added in the panel but not yet saved can't be favorited until saved.
  Same constraint cost rates already has.

### `ui/src/pages/settings/model-providers-panel.tsx`

- `ModelProvidersSettings` gains `favoriteModels`.
- Calls `fetchProviders()` on mount (as `cost-rates-panel.tsx` does) for the
  live list.
- New **Favorites** card between Providers and Default provider:
  - Header: title + outline "Add favorite" button (opens modal). Disabled with
    text "No providers available" when the live provider list is empty.
  - Empty state: "No favorite models. Add one to pin it to the top of the chat
    model menu."
  - Rows (`data-slot="favorite-row"`): truncated `provider / model`; an
    "Unavailable" badge (title: "Not in this provider's current model list")
    when the pair isn't in the live list — suppressed until the live list has
    loaded; ghost icon button (trash) with
    `aria-label="Remove {provider} / {model}"`.
  - `FieldError` for `favoriteModels`.
- No rename cascade: `provider-modal.tsx` disables the Name field in edit
  mode, so a provider's name can't change from this panel.
- All changes go through the existing `SaveDiscardBar`; nothing auto-saves.
- After Save, call `invalidateProviders()` (see §3) so chat picks up changes
  immediately. `useSettingsSection.save()` swallows its own errors, so the
  panel wraps it: `onSave={async () => { await save(); invalidateProviders(); }}`.
  Invalidating after a failed save only causes a harmless refetch.

### Settings UI tests (Jest)

- Empty state renders.
- Adding via modal appends a row and marks the form dirty.
- Remove drops the row.
- Unavailable badge shown for a pair missing from the live list; not shown
  while the live list is loading.
- Modal hides already-favorited pairs.

## 3. Chat menu

### `ui/src/hooks/use-providers.ts`

- New `favoriteModels` signal populated by `fetchProviders()` from the response.
- New `invalidateProviders()` resetting `_lastFetchedAt` so the next
  `fetchProviders()` bypasses the 60 s TTL. (Also fixes the existing staleness
  after provider edits.)

### `ui/src/components/favorite-model-items.tsx` (new)

Presentational component — deliberately **not** another option on
`useProviderModelPicker`, whose hover/focus machinery flat items don't need.

- Props: `favorites`, `activeProvider`, `activeModel`,
  `onSelect(provider, model)`.
- Returns `null` when `favorites` is empty.
- Otherwise renders: `DropdownMenuLabel` "Favorites"; one
  `DropdownMenuCheckboxItem` per favorite (checked when it matches the active
  pair; label `provider / model`, truncated, full text in `title`); a
  "Configure favorites…" `DropdownMenuItem` that routes to
  `/settings?section=model-providers` via `useLocation().route`; a
  `DropdownMenuSeparator`.

### `ui/src/components/chat-input.tsx`

- New optional prop `favoriteModels?: FavoriteModel[]`.
- Renders `<FavoriteModelItems …/>` inside the existing Provider
  `DropdownMenuSubContent`, directly above `{providerModelItems}`; selection
  calls the existing `onModelSelect`.
- No change to the Provider sub-menu's open/close logic: favorite items are in
  that sub-menu's own DOM (not a portaled child), so the `childMenuOpen` guard
  isn't involved.
- Callers that pass `providers={providers.value}` also pass
  `favoriteModels={favoriteModels.value}`: `pages/chat/index.tsx`,
  `pages/workspaces/workspace-chat-tab.tsx`, `pages/wiki/ingestion-chat.tsx`.

### Chat tests

- Jest (`favorite-model-items.test.tsx`): renders nothing when empty; one item
  per favorite plus Configure; active favorite checked; selecting calls
  `onSelect` with the pair; Configure routes to the settings page.
- Jest (`chat-input.test.tsx`): favorites render above per-provider entries;
  selecting one calls `onModelSelect`.

## 4. E2E

One CI-safe (no `@llm`) `@user-workflow` suite using the `TestSuite` pattern.
`/api/v1/providers` is mocked with `page.route()` where live model data would
otherwise require Ollama. Steps:

1. Add a favorite on the Model providers page, save, row appears.
2. Open chat → Provider menu; the favorite is listed above providers.
3. Select it; the active-model chip updates.
4. "Configure favorites…" lands on the Model providers page.
5. Remove the favorite, save; the Favorites section is gone from the chat menu.

Cleanup restores the original `favoriteModels` even on failure.

## 5. Docs

- `docs/App-Docs/configuration.md`: `favoriteModels` row + YAML example.
- `docs/App-Docs/Providers.md`: favorites section, including stale-entry
  behaviour (hidden in chat, badged in settings, never auto-removed).
- `api/config.yaml.example`: commented `favoriteModels` snippet.

## Out of scope / follow-ups

- Deleting a provider from the panel (not currently supported; the backend
  validation in §1 already guards the API path).
- Drag-to-reorder favorites.
