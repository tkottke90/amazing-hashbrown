# Per-model sampling and pricing config on providers

**Date:** 2026-10-14
**Issue:** #278

## Problem

`config.yaml` only supports sampling settings (`temperature`, `topP`, `seed`,
added on PR #277) at the **provider** level. A provider often serves several
models that disagree about what good settings are — gpt-oss on Ollama wants
`temperature: 1`, some Claude models reject an explicit `temperature`
outright — so one provider-wide value cannot be right for every model on it.

Pricing has a parallel, worse problem: it's configured in **two** separate
places with **two different units**. `providers[].models[]` already exists
and carries `{ id, inputPricePerM, outputPricePerM }`, but it's read only by
the model-picker listing. The actual cost estimates shown in observability
data and streamed to chat come from a second, top-level `costs:
Record<"provider/model", CostEntry>` map, keyed differently and priced per
1,000 tokens instead of per million. The two can silently disagree.

## Solution

Extend `providers[].models[]` to carry sampling settings per model, with
model-level values overriding provider-level defaults, and consolidate
pricing onto this same structure so there's one place and one unit for a
model's price.

### 1. Schema — `api/src/config/env.ts`

`ModelPricingSchema`/`ModelPricingConfig` are renamed to
`ModelConfigSchema`/`ModelConfig` (it stops being pricing-only) and gain six
optional sampling fields:

```ts
export const ModelConfigSchema = z.object({
  id: z.string(),
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  seed: z.number().int().optional(),
  // Ollama-only below — no OpenAI/Anthropic constructor or API equivalent
  // exists for any of these three (see createProviderFromConfig).
  numCtx: z.number().int().positive().optional(),
  topK: z.number().int().positive().optional(),
  repeatPenalty: z.number().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
```

`ProviderSchema` gains matching provider-level `numCtx`/`topK`/`repeatPenalty`
fields (same optional, Ollama-only carve-out `seed` already documents), so
all six sampling fields share one precedence rule, not just the original
three:

> A model's own value wins. If unset on the model, the provider's value
> (if any) is used. If unset on both, the underlying client's own default
> applies — identical to today's behavior for a provider with no sampling
> config at all.

`id` on a `models[]` entry matches a requested model name by **exact string
equality only** — no prefix/glob matching. A provider with several tagged
variants of the same base model (`gpt-oss:20b`, `gpt-oss:120b`) lists each
explicitly.

### 2. Resolution — `api/src/services/provider-factory.ts`

A new pure helper does the per-field merge:

```ts
export interface EffectiveSampling {
  temperature?: number;
  topP?: number;
  seed?: number;
  numCtx?: number;
  topK?: number;
  repeatPenalty?: number;
}

export function resolveEffectiveSampling(
  config: ProviderConfig,
  modelId: string,
): EffectiveSampling {
  const modelEntry = config.models?.find((m) => m.id === modelId);
  return {
    temperature: modelEntry?.temperature ?? config.temperature,
    topP: modelEntry?.topP ?? config.topP,
    seed: modelEntry?.seed ?? config.seed,
    numCtx: modelEntry?.numCtx ?? config.numCtx,
    topK: modelEntry?.topK ?? config.topK,
    repeatPenalty: modelEntry?.repeatPenalty ?? config.repeatPenalty,
  };
}
```

`createProviderFromConfig` computes `resolvedModel` (`model ?? config.defaultModel`,
unchanged) and then calls `resolveEffectiveSampling(config, resolvedModel)`,
using its output instead of reading `config.temperature`/`config.topP`/etc
directly. The `ollama` branch additionally forwards `numCtx`/`topK`/
`repeatPenalty`; the `openai` and `anthropic` branches ignore them (no
client-level equivalent). This is the only change production chat needs —
nothing else about interactive chat, headless turns, or sub-agents changes.

### 3. Eval CLI — `bin/eval.ts` / `provider-factory.ts`

**Forced-determinism path stays the default**, but needs one correctness fix:
`applyEvalDeterminism` currently pins `temperature`/`seed` at the
_provider_ level only. Once model-level overrides exist, a model with its own
`models[].temperature` would silently win over that pin inside
`resolveEffectiveSampling`, quietly breaking eval reproducibility — exactly
the bug #277 fixed, reopened by this feature if left alone. The fix:
`applyEvalDeterminism` also strips `temperature`/`seed` off of every entry in
`config.models` before pinning the provider-level fields:

```ts
export function applyEvalDeterminism(
  config: ProviderConfig,
  seed: number,
  options: { temperature?: number } = {},
): ProviderConfig {
  // Strip model-level temperature/seed so a models[] override can't
  // silently defeat the forced determinism below. Every other per-model
  // field (pricing, topP, numCtx, topK, repeatPenalty) passes through
  // untouched, same as before this feature existed.
  const models = config.models?.map(({ temperature, seed, ...rest }) => rest);
  const base = { ...config, ...(models ? { models } : {}) };
  if (base.type === 'anthropic') {
    return {
      ...base,
      seed: undefined,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    };
  }
  return { ...base, temperature: options.temperature ?? 0, seed };
}
```

**New `--use-model-sampling` flag** (default off — current forced behavior is
unchanged unless passed): for the model under test only (never the judge,
whose scoring must stay stable), resolves the model's own effective
temperature/seed via `resolveEffectiveSampling` and uses those, falling back
to the forced value (0 / the run's seed) only for whichever field the model
leaves unset. `--temperature` continues to override on top of whichever mode
is active, same as today.

**Result recording.** `EvalRunSchema` (`lib/evaluations/src/schemas.ts`)
gains an optional field:

```ts
sampling: z
  .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    seed: z.number().optional(),
    numCtx: z.number().optional(),
    topK: z.number().optional(),
    repeatPenalty: z.number().optional(),
    mode: z.enum(['forced', 'model-configured']),
  })
  .optional(),
```

`RunConfig` (`runner.ts`) gains a matching optional `sampling` field, which
`bin/eval.ts` populates from whichever config it just resolved; `computeRunSummary`
copies it onto the returned `EvalRun`. `describeSampling`'s existing
console-line stays as today's quick human-readable summary; this is the
machine-readable, persisted counterpart the issue asks for.

### 4. Costs migration — `costs` → `providers[].models[]`

Hard cutover: `costs` is no longer read for actual cost estimates once this
ships. It boots without error regardless of what `costs` contains. To avoid
_silent_ data loss (even though it isn't lossless — an unmigrated entry's
estimates go to `$0`):

- **Startup log**: if `env.costs` is non-empty, log one warning per entry:
  `config: legacy cost entry "anthropic/claude-sonnet-4-6" in costs: — move
it into providers[].models[] (see docs/App-Docs/Providers.md)`.
- **Settings UI banner**: the Model Settings page (née Cost Rates — see §6)
  shows the same list in a banner above the model list, so a browser user who
  never reads server logs still sees it. It isn't dismissible — it reflects
  live `env.costs` state and simply disappears once an entry is actually
  migrated (i.e. once that `provider/model` key no longer appears in
  `costs:`), with no separate "seen it" state to track.

`stream-handler.ts`'s cost estimate and `usage.ts`'s `seedProviderCosts()`
(which feeds the `CostStore` used by observability) both switch from reading
`env.costs` to walking `env.providers` and reading each model's
`inputPricePerM`/`outputPricePerM`. `seedProviderCosts()` converts to the
external `CostStore`'s per-1k-token shape at the boundary
(`inputPer1kTokens = inputPricePerM / 1000`, `inputScale: '1M'` fixed) —
`CostStore`'s own schema (a different package) doesn't change.

### 5. Validation — invalid per-model values

Zod's default behavior for `z.array(ProviderSchema)` fails the **entire**
array if any single nested field anywhere is malformed — and `env.providers`
today catches that and returns `[]`, i.e. one hand-edit typo anywhere in
`providers[]` currently disables every provider silently. This gets fixed as
part of landing per-model validation, following the same pattern
`parseFavoriteModels` already established in this file:

```ts
export function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { models: rawModels, ...rest } = entry as Record<string, unknown>;
    const base = ProviderSchema.omit({ models: true }).safeParse(rest);
    if (!base.success) {
      logger.warn(
        `config: provider "${(rest as { name?: string }).name ?? '?'}" is invalid — dropped`,
        {
          issues: base.error.issues,
        },
      );
      return [];
    }
    const models = Array.isArray(rawModels)
      ? rawModels.flatMap((m) => {
          const parsed = ModelConfigSchema.safeParse(m);
          if (!parsed.success) {
            const id = (m as { id?: string })?.id ?? '(no id)';
            logger.warn(
              `config: provider "${base.data.name}" model "${id}" has an invalid value — entry dropped`,
              { issues: parsed.error.issues },
            );
            return [];
          }
          return [parsed.data];
        })
      : undefined;
    return [{ ...base.data, ...(models ? { models } : {}) }];
  });
}
```

`env.providers` calls this instead of `configManager.getSection('providers',
z.array(ProviderSchema))`. One bad model entry now only drops that entry
(named, with the reason, in the log); one bad provider only drops that
provider; everything else keeps working.

### 6. Settings UI — Model Settings page

Per the agreed mockup (Option A): the Cost Rates page is renamed "Model
Settings." Same list + Add/Edit modal pattern it has today, but:

- Each row is one configured `provider/model` pair (unchanged identity:
  `providers[].models[].id` under its provider).
- The edit modal has two sections: **Pricing** (`inputPricePerM`/
  `outputPricePerM`, replacing the old `inputPer1kTokens`/`outputPer1kTokens`
  - scale fields) and **Sampling** (`temperature`, `topP`, `seed`, `numCtx`,
    `topK`, `repeatPenalty`, each optional — blank means unset, not zero).
    `numCtx`/`topK`/`repeatPenalty` are Ollama-only (§1) — the modal hides
    those three fields when the row's provider isn't type `ollama`, so the form
    never implies a control exists that `createProviderFromConfig` would
    silently drop.
- `inputScale`/`outputScale` are dropped entirely — they were always
  UI-only display metadata with no effect on calculation. The per-1k/per-1M
  toggle stays as an input convenience in `ScaledCostInput`, converting to
  per-million before the value is saved, rather than persisting which unit
  was typed.
- The legacy-costs banner (§4) sits above the list.
- Writes go to the matching provider's `models[]` array (`PATCH` handler for
  the `'cost-rates'` settings slug is renamed/rewritten to locate the
  provider by name and upsert into its `models[]`, instead of merging a
  top-level `costs` key).

### 7. Documentation

- `docs/App-Docs/Providers.md` gains a full `models[]` section: every field
  (pricing + all six sampling fields), the exact-match rule for `id`, and the
  precedence rule from §1. Today this field is entirely undocumented.
- `docs/App-Docs/configuration.md`'s "Cost Rates" section is rewritten to
  describe `providers[].models[]` as the pricing location, with a migration
  note pointing existing `costs:` users at the startup warning and banner.
- `docs/App-Docs/Evaluations.md` documents `--use-model-sampling` and the new
  `sampling` field on a result.

## Error handling

- Malformed `models[]` entry or malformed provider: dropped with a logged
  warning naming the provider and (for a model entry) the model id — never a
  silent empty list, never a crash (§5).
- Legacy `costs` entries: never an error — logged once at startup and shown
  in the Settings UI; estimates for unmigrated entries read `$0` until moved.
- `applyEvalDeterminism`/`--use-model-sampling`: pure data transforms, never
  throw.
- A sampling field unsupported by a given client type (e.g. `seed` on
  Anthropic) is silently never forwarded — a permanent API constraint, not an
  error, matching the existing `seed` precedent.

## Testing

- **`env.test.ts`**: `ModelConfigSchema` accepts all nine fields;
  `parseProviders` drops only a malformed model entry (keeping the provider
  and its other models), drops only a malformed provider (keeping the rest
  of `providers[]`), and logs a message naming the provider/model in each
  case.
- **`provider-factory.test.ts`**: `resolveEffectiveSampling` precedence
  (model overrides provider, provider overrides nothing, each field
  independently); `createProviderFromConfig` forwards `numCtx`/`topK`/
  `repeatPenalty` onto `ChatOllama` only; `applyEvalDeterminism` strips
  model-level `temperature`/`seed` while leaving other per-model fields
  (including pricing) intact.
- **`usage.test.ts`** (or equivalent): `seedProviderCosts()` reads pricing
  from `providers[].models[]`, not `costs`, and converts units correctly.
- **Settings route orchestration test**: `PATCH` for the Model Settings slug
  upserts into the correct provider's `models[]`; `GET` surfaces legacy
  `costs` entries for the banner.
- **UI (Jest)**: Model Settings panel renders Pricing + Sampling sections;
  save round-trips through the per-million fields with no `scale` field.
- **E2E**: existing Cost Rates E2E coverage updated for the renamed page and
  modal sections — not new scenarios, since the user-facing flow (add/edit/
  delete a rate) is unchanged in shape.
- **`bin/eval.ts`**: no new automated test, consistent with this file's
  existing precedent (no `bin/*.test.ts` exists anywhere in the repo).
  Manual verification: running a suite with `--use-model-sampling` against a
  provider with a per-model `temperature` set produces a result YAML whose
  `sampling.mode` is `'model-configured'` and whose `sampling.temperature`
  matches the configured value; omitting the flag reproduces today's
  `mode: 'forced'`, `temperature: 0` behavior unchanged.

## Out of scope

- A Settings UI for favoriting or bulk-editing many models at once — Model
  Settings keeps the existing one-row-at-a-time Add/Edit modal pattern.
- Prefix/glob matching for `models[].id` — exact match only (§1); can be
  revisited if real configs show enough tag-variant duplication to justify
  it.
- Baseline (`eval-baselines.yaml`) changes to record sampling mode — tracked
  separately per #272/#273, same carve-out the eval-determinism design
  (#271) already made.
- Any change to which fields `CostStore` (the external `@tkottke90/observability`
  package) itself persists — only the data fed into it at the `usage.ts`
  boundary changes.
