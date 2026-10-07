# Eval harness: deterministic provider sampling + required judge model

**Date:** 2026-10-06
**Issue:** #271 (part of the eval-reliability epic, #270)

## Problem

Eval results are currently unreliable, and two confirmed defects in
`api/src/services/provider-factory.ts` and `bin/eval.ts` are the root cause:

1. **No temperature/seed control anywhere in provider construction.**
   `createProviderFromConfig` builds `ChatOllama`/`ChatOpenAI`/`ChatAnthropic`
   with no `temperature`, `topP`, or `seed` passed to any constructor — for
   the model under test _and_ the judge, since both go through the same
   factory. This project's own commit history already measured the effect:
   `api/src/services/default-skills.ts:59-64,95-98` attributes specific
   scenario pass/fail flips to unseeded sampling variance, and
   `docs/superpowers/specs/2026-09-14-wiki-navigation-section-restructure-design.md:11,18`
   documents a confirmed **4/7 (~57%) pass-rate swing across identical
   reruns** of the same scenario/model/commit.
2. **`--judge-model` silently falls back to `--model`.** `bin/eval.ts:160`:
   `const judgeModelId = values['judge-model'] ?? values.model;`. Omitting
   the flag makes the judge grade the exact model it's supposed to
   independently evaluate. The only existing safeguard —
   `biasRisk: judgeModelId === modelId` in
   `lib/evaluations/src/executors/llm-judge.ts:79` — only sets a boolean in
   the result JSON; it never blocks, warns at the CLI, or affects scoring.
   This also contradicts the harness's original design intent
   (`docs/Design/2026-07-15-evaluation-harness-design.md:409-411,990`:
   the judge model "must be provided explicitly... no same-model
   fallback").

Full findings: `docs/Design/2026-10-06-eval-system-reliability-audit.md`,
§2.1–§2.3.

## Solution

**Approach:** extend `ProviderSchema` with optional `temperature`/`topP`/`seed`
fields, wire them through all three `createProviderFromConfig` branches
(generically useful, but inert unless something sets them), add a new
`applyEvalDeterminism()` helper that forces `temperature: 0` and a fixed
`seed` onto a resolved ollama/openai-type provider config (anthropic
providers can take neither — see §3), and have `bin/eval.ts` apply it to
both the target and judge model it constructs — regardless of what
`config.yaml` has set for that provider's everyday chat use. Separately,
make `--judge-model` a hard requirement instead of a silent fallback.

Two alternatives were considered and rejected:

- **Mutating constructed client instances' public fields directly**
  (`model.temperature = 0` after construction) avoids a schema change but
  relies on undocumented mutable properties and contradicts
  `provider-factory.ts`'s own stated design as "a pure factory — accepts
  explicit config."
- **A separate eval-only provider-construction module** avoids touching
  production code at all, but duplicates all three constructor branches —
  a direct violation of this repo's "Composition over Customization"
  principle (root `AGENTS.md`), and would need to be hand-kept in sync
  with `provider-factory.ts` forever.

### 1. Schema change — `api/src/config/env.ts`

```ts
export const ProviderSchema = z.object({
  name: z.string(),
  type: z.enum(['ollama', 'openai', 'anthropic']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(ModelPricingSchema).optional(),
  maxConcurrency: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  // Only forwarded for ollama/openai-type providers — Anthropic's API has
  // no seed parameter, and ChatAnthropic exposes no such constructor
  // option. See createProviderFromConfig's anthropic branch.
  seed: z.number().int().optional(),
});
```

All three fields are optional, following the same pattern as
`maxConcurrency`/`timeoutMs`. A production provider entry in `config.yaml`
could opt into them later, but nothing in this change makes production
chat use them — only the eval CLI sets them, via §3 below.

### 2. `createProviderFromConfig` changes — `api/src/services/provider-factory.ts`

Each branch forwards the new fields where the underlying LangChain client
actually supports them:

```ts
case 'ollama':
  return new ChatOllama({
    model: resolvedModel,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    topP: config.topP,
    seed: config.seed,
  });

case 'openai':
  return new ChatOpenAI({
    model: resolvedModel,
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    temperature: config.temperature,
    topP: config.topP,
    // `seed` is a per-call option on ChatOpenAI, not a constructor field;
    // modelKwargs is spread into every request body.
    modelKwargs: config.seed === undefined ? undefined : { seed: config.seed },
    configuration: {
      baseURL: config.baseUrl,
      fetch: process.env.DEBUG_LLM_HTTP === '1' ? loggingFetch : undefined,
    },
  });

case 'anthropic':
  return new ChatAnthropic({
    model: resolvedModel,
    apiKey: config.apiKey,
    temperature: config.temperature,
    topP: config.topP,
    // no `seed` — Anthropic's API has no such parameter.
    clientOptions: { timeout: config.timeoutMs },
  });
```

All three fields are `undefined` when not set on `config`, which every
LangChain chat model treats as "use the provider's own default" — this is
a strictly additive change with no effect on any existing caller until
something actually sets these fields.

**Verified field names** (against `@langchain/ollama` 1.3.0,
`@langchain/openai` 1.5.5, `@langchain/anthropic` 1.5.1, by reading the
published type declarations and constructing real instances):

- `ChatOllama` takes `temperature`, `topP` and `seed` as top-level
  constructor fields and exposes them as instance properties.
- `ChatOpenAI` takes `temperature` and `topP` top-level, but `seed` is
  only a per-call option (`ChatOpenAICallOptions`), not a constructor
  field. It is carried via `modelKwargs`, which the completions client
  spreads into the request body after its own params. This corrects the
  first draft of this section, which assumed a top-level `seed`.
- `ChatAnthropic` takes `temperature` and `topP`; it has no `seed` concept.

This confirms request-construction only. Whether a given server (Lemonade,
DigitalOcean) actually honours `seed`, and whether a given Claude model
accepts an explicit `temperature`, can only be confirmed by a real run.

### 3. Eval-only determinism override

New exported helper, next to `createProviderFromConfig` in
`provider-factory.ts`:

```ts
/**
 * Returns a copy of `config` with temperature pinned to 0 and a fixed
 * seed applied — used only by the eval CLI, never by production provider
 * resolution. Existing explicit temperature/seed values are overridden,
 * since the whole point of an eval run is reproducibility regardless of
 * what config.yaml has set for everyday chat use.
 *
 * Anthropic providers are deliberately left unpinned (see below).
 */
export function applyEvalDeterminism(config: ProviderConfig, seed: number): ProviderConfig {
  if (config.type === 'anthropic') {
    return { ...config, seed: undefined };
  }
  return { ...config, temperature: 0, seed };
}
```

**Anthropic is not pinned at all.** The first draft of this section pinned
`temperature: 0` on an anthropic judge and only withheld the seed. A real run
disproved that: current Claude models reject an explicit `temperature` with
`400 temperature is deprecated for this model`, which failed every
judge-scored scenario. So for an anthropic provider the helper injects no
temperature and no seed (a `temperature` the user set explicitly in
`config.yaml` is passed through as written). A Claude judge therefore runs at
its own default sampling, and some variance in judge-scored scenarios is
expected and cannot be engineered away from our side.

`bin/eval.ts` changes its target/judge-model construction from:

```ts
model = createProvider(modelId);
judgeModel = createProvider(judgeModelId);
```

to:

```ts
model = createProviderFromConfig(applyEvalDeterminism(resolveProviderConfig(modelId), seed));
judgeModel = createProviderFromConfig(
  applyEvalDeterminism(resolveProviderConfig(judgeModelId), seed),
);
```

`seed` comes from a new `--seed <n>` CLI flag (parsed via `parseArgs` as a
string, converted to a number), defaulting to a module-level constant
(`DEFAULT_EVAL_SEED = 42`) when omitted. Both the target model and the
judge model use the **same** seed value — they're different provider/model
instances regardless, so there's no shared-randomness concern, and one
flag is simpler than exposing two. Being able to override the seed is
useful on its own: re-running a suite with a _different_ fixed seed is how
you tell "this scenario is seed-sensitive" apart from "this scenario is
actually stable."

**`--temperature <n>` (added after the first real runs).** Pinning temperature 0
can itself be the wrong setting: OpenAI recommends `temperature=1.0` for gpt-oss,
and a provider's `temperature` in `config.yaml` has no effect on an eval run
because the override replaces it. `--temperature` replaces the pinned 0 for the
**model under test only** — never the judge, whose scoring must stay stable and
which may be an anthropic provider that rejects the parameter. The seed is
still applied. Each run prints a `[eval] sampling — …` line with the
temperature, `top_p` and seed actually used (`describeSampling`), since results
previously did not say.

### 4. Required `--judge-model`

`bin/eval.ts` replaces the silent fallback with a hard failure, placed
next to the existing `--model` requirement check:

```ts
if (!values.model) {
  console.error('Error: --model <name> is required');
  process.exit(2);
}
if (!values['judge-model']) {
  console.error(
    'Error: --judge-model <name> is required — no same-model fallback. ' +
      'Pass an explicit --judge-model (it may equal --model if you intend ' +
      'a deliberate self-judging run).',
  );
  process.exit(2);
}

const modelId = values.model;
const judgeModelId = values['judge-model'];
```

The `biasRisk: judgeModelId === modelId` check in
`lib/evaluations/src/executors/llm-judge.ts:79` is unchanged — it still
flags an explicit same-model run, which is the intentional case this
change deliberately continues to allow (block the silent default, not a
deliberate choice).

### 5. Documentation

`docs/App-Docs/Evaluations.md:55` currently documents the old fallback
("same as `--model`"). It gets corrected to describe the new required
flag, the still-allowed-but-flagged same-model case, the new `--seed`
flag and its default, and the Anthropic-has-no-seed limitation — stated
plainly so it isn't mistaken for a bug later.

## Error handling

- Missing `--model` or `--judge-model`: `process.exit(2)` with a specific
  message, matching the existing `--model` check's style.
- `applyEvalDeterminism` never throws — it's a pure data transform.
- Anthropic's lack of `seed` support, and its models' rejection of an
  explicit `temperature`, are silent, by-design omissions (nothing is
  injected for an anthropic provider), not errors — they are permanent API
  constraints, not transient failures.

## Testing

- **`provider-factory.test.ts`** (existing file, no sinon — asserts on
  real constructed instances' public fields, per its existing convention):
  - `createProviderFromConfig` forwards `temperature`/`topP`/`seed` onto
    the constructed `ChatOllama` instance, and `temperature`/`topP` plus
    `modelKwargs.seed` onto `ChatOpenAI`, when present on config.
  - `createProviderFromConfig` forwards `temperature`/`topP` but never
    `seed` onto a constructed `ChatAnthropic` instance.
  - `applyEvalDeterminism`: returns `temperature: 0` and the passed `seed`
    for `ollama`/`openai` configs; for an `anthropic` config injects no
    temperature, returns `seed: undefined`, and keeps a temperature the
    user explicitly configured.
- **`bin/eval.ts`**: no new automated test. No `bin/*.test.ts` file exists
  anywhere in this repo today, and the existing `--model`-required check
  has never had one either — consistent with that precedent, this change
  doesn't introduce a new test harness just for CLI argument validation.
  Verification is manual, per the measurable outcomes already recorded in
  issue #271: running `npm run eval` without `--judge-model` exits
  non-zero; running the same suite+model+judge 5 consecutive times
  produces identical scenario-level pass/fail verdicts in all 5 runs for
  at least 3 suites that previously showed documented variance (e.g.
  `wiki-navigation.yaml`, `create-workspace-project.yaml`).

## Out of scope

- Any change to production chat's provider construction behavior —
  `temperature`/`topP`/`seed` are additive schema fields nobody but the
  eval CLI sets.
- The other `bin/eval-*.ts` scripts — confirmed via grep that none of them
  construct models independently of `bin/eval.ts`.
- Re-baselining `eval-baselines.yaml`, adding variance tracking to it, or
  wiring an automated regression check — tracked separately in #272/#273,
  and depend on this issue landing first.
- `auto-eval-loop`'s repeat-failure safeguard and its `.gitignore` commit
  bug — tracked separately in #274.
- Any suite content changes (`suites/*.yaml`) — tracked separately in
  #275/#276.
