# Settings UI Design

**Date:** 2026-08-06
**Status:** Approved

## Goal

Build the Settings page behind the sidebar "Settings" nav icon. The page exposes all configuration knobs defined in `api/src/config/env.ts` as editable forms, persists changes to `config.yaml` via the backend, and reloads affected services in memory after each save.

---

## Architecture Overview

### Backend

A single Express controller handles `GET /api/v1/settings/:slug` and `PATCH /api/v1/settings/:slug`. Each slug maps to a slice of the `AppConfigSchema` Zod schema in `env.ts` — that schema is the canonical source of truth for field names, types, defaults, and validation rules. The controller validates incoming PATCH bodies against the relevant sub-schema and returns 404 for unrecognised slugs.

The `configManager` in `env.ts` is already initialised with `writeBack: true`. The controller uses `configManager` to write changed values back to `config.yaml` and then triggers an in-memory reload of the affected services.

### Frontend

A single `/settings` route renders `SettingsView`. The active section is driven by a `?section=` URL query parameter (e.g. `/settings?section=storage`), following the same pattern as the wiki's `?view=` and `?page=` params. Missing or invalid `?section` values default to `general`. The sidebar nav items update the query param via `useLocation().route()` — no full navigation occurs.

### Data Flow

1. User navigates to `/settings?section=embeddings`
2. `SettingsView` reads `query.section`, renders the Embeddings panel
3. The panel calls `GET /api/v1/settings/embeddings` on mount to fetch current values
4. User edits fields → form state diverges from saved state → Save/Discard bar becomes active
5. "Save changes" → `PATCH /api/v1/settings/embeddings` with changed values
6. Backend validates against the section's Zod sub-schema, writes to `config.yaml`, reloads affected in-memory services
7. Success: success toast; failure: 400 validation errors displayed inline beneath affected fields, or 500 error toast

---

## Backend

### New Files

| File                                         | Purpose                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `api/src/controllers/settings.controller.ts` | GET and PATCH handlers; slug → sub-schema mapping; 404 for unknown slugs |

### Modified Files

| File                                  | Change                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `api/src/routes/v1/settings.route.ts` | Add `GET /:slug` and `PATCH /:slug` wired to the controller; keep existing `POST /reload` |

### Valid Slugs

| Slug              | Config keys written                                                       | In-memory reload              |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------- |
| `general`         | `logLevel`                                                                | Logger level                  |
| `storage`         | `wikiRoot`, `mcpConfigDir`, `artifactRoot`, `skillsRoot`, `database.path` | Path references               |
| `model-providers` | `providers`, `defaultProvider`                                            | Provider registry, chat agent |
| `embeddings`      | `embeddings`                                                              | Embedding client              |
| `agent-behavior`  | `afterAgent`, `chat`, `observability`                                     | Middleware flags              |
| `tools`           | `webFetch`, `rlm`, `tools`                                                | Tool configurations           |
| `cost-rates`      | `costs`                                                                   | Usage/cost seeding            |

`mcp-servers` and `skills` return 404 on PATCH. Their GET responses may return an empty object as a placeholder.

### Section Sub-Schemas

Each slug's PATCH body is validated against the corresponding Zod sub-schema exported from `env.ts`. The controller rejects bodies that fail validation with a 400 response containing field-level error details.

### API Key Masking

Provider `apiKey` values are masked in GET responses — the raw string is replaced with `****` if set, or omitted if absent. A PATCH body that sends `****` (unchanged mask) leaves the stored value untouched. A PATCH body that sends a new plaintext string replaces it. A PATCH body that sends an empty string clears it.

---

## Frontend

### Routing Change

`app.tsx`:

- The `<Router>` gets a `<SettingsRoot path="/settings" />` route
- The `href="#"` stub on the Settings nav icon becomes `href="/settings"`

### New Files

```
ui/src/pages/settings-view.tsx              # Top-level page; reads ?section, renders sidebar + panel
ui/src/components/settings/
  settings-nav.tsx                          # Sidebar nav list; pushes ?section= on click
  use-settings-section.ts                  # Shared hook: fetch, dirty tracking, save, discard
  general-panel.tsx
  storage-panel.tsx
  model-providers-panel.tsx
  provider-modal.tsx                        # Add / Edit modal for a single provider
  embeddings-panel.tsx
  agent-behavior-panel.tsx
  tools-panel.tsx
  cost-rates-panel.tsx
  rate-modal.tsx                            # Add / Edit modal for a cost rate entry
  placeholder-panel.tsx                    # Shared empty state for MCP Servers and Skills
```

### `useSettingsSection` Hook

```ts
function useSettingsSection<T>(slug: string): {
  data: T | null; // last saved values from GET response
  form: T | null; // dirty copy the user is editing
  isDirty: boolean;
  isSaving: boolean;
  setField: (path: string, value: unknown) => void;
  save: () => Promise<void>;
  discard: () => void;
};
```

- Calls `GET /api/v1/settings/:slug` on mount
- `save()` calls `PATCH /api/v1/settings/:slug`, sets `isSaving = true` for the duration, shows success or error toast on completion
- `discard()` resets `form` to the last value of `data`

### `?section=` Navigation

`SettingsView` reads `useLocation().query.section`. The sidebar nav calls `route('/settings?section=<slug>')` on click. Missing or unrecognised values default to `general`. No last-section caching.

### Nav Sections (in order)

| Label           | Slug              |
| --------------- | ----------------- |
| General         | `general`         |
| Storage         | `storage`         |
| Model providers | `model-providers` |
| Embeddings      | `embeddings`      |
| Agent behavior  | `agent-behavior`  |
| Tools           | `tools`           |
| Cost rates      | `cost-rates`      |
| MCP Servers     | `mcp-servers`     |
| Skills          | `skills`          |

---

## Section Details

### Field Definitions

Field names, types, defaults, and validation rules are determined by the Zod schemas in `api/src/config/env.ts`. The descriptions below are illustrative; the schema is authoritative.

**General** (`AppConfigSchema`: `port`, `logLevel`)

- Port — read-only display field; not editable via the UI. Changing the port requires an environment-level change and server restart.
- Log level — select; options derived from the `logLevel` field (string; common values: `debug`, `info`, `warn`, `error`)

**Storage** (`wikiRoot`, `mcpConfigDir`, `artifactRoot`, `skillsRoot`, `database.path`)

- Five text inputs for directory and file paths; descriptions sourced from designs.

**Model providers** (`providers[]`, `defaultProvider`)

- Provider list: each row shows name, type badge, default model, host, Default badge if it matches `defaultProvider`, and an Edit button
- Add provider button opens `provider-modal` in add mode
- Default provider select populated from current provider names
- `provider-modal` fields follow `ProviderSchema`: name, type (select: `ollama` / `openai` / `anthropic`), baseUrl, apiKey (masked), defaultModel
- Modal saves update local form state only; config is not written until the panel "Save changes" is clicked

**Embeddings** (`EmbeddingsSchema`)

- Enable embeddings toggle
- Type, model, baseUrl fields shown conditionally when enabled; field types follow `EmbeddingsSchema`

**Agent behavior** (`AfterAgentSchema`, `ChatSchema`, `ObservabilitySchema`)

- Three card subsections: Background processing, Conversation history, Observability
- Span output preview field shown conditionally when tracing is enabled

**Tools** (`WebFetchConfigSchema`, `RLMConfigSchema`, `ToolsConfigSchema`)

- Three card subsections: Web fetch, Retrieval loop model, Shell execution
- Shell allowlist and denylist rendered as textareas (one glob per line); serialised to/from `string[]`
- RLM provider select populated from current provider names plus a "Default provider" option

**Cost rates** (`costs: Record<string, CostEntrySchema>`)

- Rate list: each row shows model key and input/output prices; rows are editable and deletable
- Empty state shown when `costs` is `{}`; includes an "Add rate" prompt
- `rate-modal` fields: model key (string), input per 1k tokens (number), output per 1k tokens (number)
- Note: `CostEntrySchema` uses `inputPer1kTokens` / `outputPer1kTokens`; `ModelPricingSchema` inside providers uses `inputPricePerM` / `outputPricePerM` — these are distinct

**MCP Servers / Skills**

- `PlaceholderPanel` renders a centred empty state with section title and "Coming soon" note

---

## Shared UI Patterns

### Save/Discard Bar

Every panel renders an identical footer bar:

- **Save changes** — primary button; shows a loading spinner and is disabled while `isSaving` is true; hidden when `!isDirty`
- **Discard** — ghost button; resets form to last-fetched values; hidden when `!isDirty`

### Error Handling

| Scenario             | Behaviour                                                              |
| -------------------- | ---------------------------------------------------------------------- |
| 400 from PATCH       | Field-level error messages displayed inline beneath the relevant input |
| 500 from PATCH       | Error toast                                                            |
| GET failure on mount | Error state rendered in place of the form                              |
| Save success         | Success toast                                                          |

### Modals

`provider-modal` and `rate-modal` use `preact-dialog`. Both support Add and Edit modes. Edit mode pre-populates from the row's current values. Saving a modal entry updates local form state and marks the panel dirty; the config is not written to disk until the panel-level "Save changes" is clicked.

---

## Out of Scope

- MCP Servers management UI (placeholder nav entry only)
- Skills management UI (placeholder nav entry only; tracked as a separate item)
- Theme toggle (already handled by the existing `ThemeToggle` component in the nav bar)
- Server restart trigger from the UI
