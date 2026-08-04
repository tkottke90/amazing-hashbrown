# Provider / Model Switcher — Design

**Date:** 2026-08-04
**Status:** Approved
**Issue:** [#45 — Add provider/model switcher menu to chat input](https://github.com/tkottke90/amazing-hashbrown/issues/45)

---

## 1. Problem & Goal

Users currently have no way to switch the AI provider or model from within the chat interface. Changing models requires manually editing `config.yaml` and restarting the API — a disruptive, non-discoverable workflow.

This feature adds an inline provider/model switcher to the chat input bar. The selection is scoped to the active thread, persisted to the database, and recorded on each assistant message so the full model history of a thread is visible.

---

## 2. Config Schema Changes

`config.yaml` gains an optional `models` array under each provider entry. The inference engine's live `/models` endpoint remains the authoritative source for which models exist; the config array is a pure pricing annotation layer — entries whose IDs do not appear in the live models list are ignored.

```yaml
providers:
  - name: openai
    type: openai
    apiKey: sk-...
    defaultModel: gpt-4o
    models:
      - id: gpt-4o
        inputPricePerM: 2.50
        outputPricePerM: 10.00
      - id: gpt-4o-mini
        inputPricePerM: 0.15
        outputPricePerM: 0.60
```

Both `inputPricePerM` and `outputPricePerM` are optional. A model present in the live list but absent from the config `models` array still appears in the UI — just without pricing.

**Zod schema additions (`api/src/config/env.ts`):**

```typescript
const ModelPricingSchema = z.object({
  id: z.string(),
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
});

// Added to ProviderSchema:
models: z.array(ModelPricingSchema).optional(),
```

---

## 3. API Changes

### `GET /api/v1/providers`

Response is extended to include per-model pricing. The handler merges the live models list (from the inference engine) with pricing from config, keyed by model ID:

```json
{
  "providers": [
    {
      "name": "openai",
      "type": "openai",
      "defaultModel": "gpt-4o",
      "models": [
<<<<<<< HEAD
        { "id": "gpt-4o", "inputPricePerM": 2.5, "outputPricePerM": 10.0 },
        { "id": "gpt-4o-mini", "inputPricePerM": 0.15, "outputPricePerM": 0.6 },
=======
        { "id": "gpt-4o", "inputPricePerM": 2.50, "outputPricePerM": 10.00 },
        { "id": "gpt-4o-mini", "inputPricePerM": 0.15, "outputPricePerM": 0.60 },
>>>>>>> eb15a74 (docs: add design spec for provider/model switcher (issue #45))
        { "id": "gpt-3.5-turbo" }
      ]
    }
  ]
}
```

Models returned by the inference engine but not annotated in config appear without pricing fields.

### `POST /api/v1/chat/:threadId`

Provider/model resolution order (first match wins):

1. `provider` / `model` in the request body (explicit per-message override)
2. `threads.provider` / `threads.model` for the active thread
3. `env.defaultProvider` + provider's `defaultModel` (existing global fallback)

When the request body includes `provider` and/or `model`, the API updates `threads.provider` and `threads.model` as part of processing the message — no dedicated model-selection endpoint.

---

## 4. Database Changes

Both `ALTER TABLE` statements run at `ThreadStore` startup, guarded by `PRAGMA table_info(...)` checks so they are idempotent on existing databases.

### `threads` table

```sql
ALTER TABLE threads ADD COLUMN provider TEXT;
ALTER TABLE threads ADD COLUMN model    TEXT;
```

`NULL` means "use global default". Updated whenever a chat message is sent with an explicit provider/model in the body.

### `thread_messages` table

```sql
ALTER TABLE thread_messages ADD COLUMN provider TEXT;
ALTER TABLE thread_messages ADD COLUMN model    TEXT;
```

Populated at message-write time with the resolved provider and model for that call. `NULL` for user messages and non-assistant message kinds (tool calls, HITL prompts, etc.). This record is immutable after creation — it represents what was actually used for that message, not the thread's current selection.

---

## 5. Frontend State

### `use-providers.ts` (new)

Module-level signals:

```typescript
const providers = signal<ProviderInfo[]>([]);
const providersLastFetchedAt = signal<number>(0);
```

`fetchProviders()` — checks if `Date.now() - providersLastFetchedAt.value > 60_000`. If stale (or never fetched), calls `GET /api/v1/providers` and updates both signals. Otherwise returns immediately. Called in `chat-input.tsx`'s `useEffect` on mount, so every time the chat input appears the cache validity is checked.

### `use-thread.ts` (extended)

The `ThreadSummary` type gains `provider: string | null` and `model: string | null` fields, populated from the API. A `setThreadModel(provider: string, model: string)` function updates the active thread entry in the `threads` signal immediately (optimistic update). The resolved values are included in the `sendMessage` POST body.

`sendMessage` change:

```typescript
await consumeSsePost(
  `/api/v1/chat/${activeThreadId.value}`,
  { content, provider: activeThread.provider, model: activeThread.model },
  handleEvent,
  _abortController.signal,
);
```

**Active model resolution** — a computed signal derives the display value for the chip and menu highlighted state:

1. Active thread's `model` signal value
2. Active provider's `defaultModel`
3. First model in the providers list

---

## 6. UI Components

### Chat input dropdown (extended)

The existing `DropdownMenu` in `chat-input.tsx` gains a "Provider" item alongside "Add File". The Provider item opens a `DropdownMenuSub` with two nested levels — provider selection, then model selection:

```
+ (trigger)
├── Add File
└── Provider  ▶
              ├── openai  (highlighted if active)  ▶
              │           ├── gpt-4o  ✓ (active)
              │           │   $2.50 / 1M input · $10.00 / 1M output
              │           └── gpt-4o-mini
              │               $0.15 / 1M input · $0.60 / 1M output
              └── ollama                           ▶
                          └── llama3.2
```

- Provider items: `DropdownMenuSubTrigger`. The active provider is visually highlighted (bold text or accent color via className).
- Model items: `DropdownMenuCheckboxItem` — the active model gets a checkmark.
- Pricing: a non-interactive `DropdownMenuLabel` styled as muted small text, rendered only when both `inputPricePerM` and `outputPricePerM` are present. Gracefully omitted otherwise — no placeholder text.
- Selecting a model calls `setThreadModel(provider, model)`.

### `ModelChip` (new)

A small read-only pill component placed in the `actions` grid area of the chat input, alongside the `+` trigger button. Displays the resolved active model name (e.g., `gpt-4o`). Renders nothing while providers are still loading to avoid layout shift. Styled as a muted, non-interactive badge — no click handler of its own.

```tsx
function ModelChip() {
  const model = activeModelComputed.value;
  if (!model) return null;
  return <span class="model-chip">{model}</span>;
}
```

---

## 7. Files Changed

| File | Change |
|---|---|
| `api/src/config/env.ts` | Add `ModelPricingSchema`, extend `ProviderSchema` |
| `api/src/routes/v1/providers.route.ts` | Merge live models with config pricing in response |
| `api/src/services/thread-store.ts` | DB migrations; extend read/write for `provider`/`model` columns |
| `api/src/routes/v1/chat.route.ts` | Provider/model resolution order; update thread on body params |
| `api/src/agents/stream-handler.ts` | Write resolved `provider`/`model` to `thread_messages` |
| `ui/src/hooks/use-providers.ts` | New — cached provider/model list with 60s TTL |
| `ui/src/hooks/use-thread.ts` | Extend `ThreadSummary` type; add `setThreadModel`; extend `sendMessage` |
| `ui/src/components/chat-input.tsx` | Extend dropdown; add `ModelChip`; call `fetchProviders` on mount |
| `ui/src/components/ui/dropdown-menu.tsx` | No change — sub-menu primitives already present |

---

## 8. Out of Scope

- Persisting model selection across browser storage separately from the backend thread record
- A dedicated model-management or pricing-editing UI
- Automatic pricing data for models not annotated in `config.yaml`
- Any change to the SSE response format
