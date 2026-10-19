# AfterAgent Domain Fit Gate — Design

**Date:** 2026-10-18
**Status:** Draft
**Related:** [Issue #333](https://github.com/tkottke90/amazing-hashbrown/issues/333) (root-caused in that issue's comments — not a write-scope bypass), [`GLOSSARY.md`](../../../GLOSSARY.md) "AfterAgent & Wiki Write Scope" section, [ADR-0014](../../adr/0014-afteragent-gates-on-domain-fit-not-mandatory-binding.md), [ADR-0015](../../adr/0015-review-band-becomes-a-placement-review-task.md), [AfterAgent Middleware design](../../Design/2026-07-17-afteragent-middleware-design.md), [Workspace Dedicated Wiki & Scoped Wiki Writes](2026-09-28-workspace-dedicated-wiki-design.md)

## Purpose

Stop AfterAgent from committing a wiki write when none of the domains it's allowed to write to actually fit the content, without retiring Open Scope as a legitimate mode. See ADR-0014 for why this is a judgment gate on `extract`'s output rather than a push toward mandatory wiki binding.

## Background

Issue #333 reported AfterAgent writes landing in unrelated wiki domains from a workspace with no Bound Wiki. The write-scope guardrail from #79/#202 was confirmed working correctly — every domain offered to `extract` was already filtered through `checkWikiWrite`. The actual gap: once `classify` says a turn is worth saving, the pipeline is committed to writing _somewhere_, and `extract`'s prompt had no way to say "none of these candidates are a good match." Under Open Scope, "these candidates" can be every unclaimed domain in the registry, topically unrelated or not — so a weak match became a near-arbitrary one.

This design adds a Domain Fit Score to `extract`'s output and three bands of behavior based on it. See `GLOSSARY.md`'s "AfterAgent & Wiki Write Scope" section for Write Scope / Locked Scope / Open Scope / Bound Wiki and for Domain Fit Score / Write Band / Review Band / Drop Band / Placement Review Task / Disposition — this document uses those terms as defined there rather than redefining them.

## Scope

**In scope:** preventing future misroutes via the Domain Fit Score gate described below.
**Out of scope:** relocating or cleaning up the pages already misfiled by the #333 incident — that's normal wiki operation (manual edit/move), not a mechanism this spec builds. Also out of scope: any change to when a workspace gets a Bound Wiki, or to workspace-creation UX (ADR-0014).

## Design

### 1. `extract` gains a Domain Fit Score

`api/src/agents/after-agent.ts`'s `ExtractOutputSchema` gains a required field:

```ts
const ExtractOutputSchema = z.object({
  domainId: z.string().describe('The id of the wiki domain this content belongs in.'),
  fitScore: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe(
      'How well this content actually matches domainId, from 1 (no real match) to 10 ' +
        '(obviously belongs here). Judge this independently of whether the content is worth ' +
        'saving at all — that was already decided.',
    ),
  type: z.enum(['entity', 'concept', 'comparison', 'query', 'summary']),
  title: z.string(),
  tags: z.array(z.string()),
  body: z.string().describe('Page body as markdown (no frontmatter).'),
  summary: z.string().optional().describe('One-line summary for the wiki index entry.'),
});
```

`buildExtractPrompt` gains a paragraph instructing the model to rate fit honestly against the specific candidate list it was given, independent of novelty (already judged by `classify`).

`classify` is unchanged — it stays a binary "is this worth saving at all" gate with no visibility into candidate domains, per the decision to keep novelty and domain-fit as two independent judgments.

### 2. Band thresholds

Three named constants in `after-agent.ts`, not a `config.yaml` setting (tuned by changing the number and re-running `suites/after-agent.yaml`, same as any other prompt-tuning in this pipeline):

```ts
const WRITE_BAND_MIN = 8; // fitScore >= this: commit immediately
const REVIEW_BAND_MIN = 5; // fitScore >= this (and < WRITE_BAND_MIN): Placement Review Task
// fitScore < REVIEW_BAND_MIN: Drop Band — treated as no-op
```

### 3. Band applies only under Open Scope

Immediately after `extract` returns, before doing anything else:

```ts
const gated = scope.kind === 'open';
const band = !gated ? 'write' : fitScoreBand(extract.fitScore); // 'write' | 'review' | 'drop'
```

Under Locked Scope, `band` is always `'write'` — there is exactly one candidate domain (the workspace's Bound Wiki), so a low score reflects a mediocre tag match, not real ambiguity, and shouldn't block or defer a write the user already pre-approved by binding.

### 4. Write Band — unchanged

Exactly today's path: `ingestPrep` → `saveRawSource` → merge-if-duplicate → `createWikiPage`/`updateWikiPage` → `queueWikiUpdate` → `setAfterAgentDone(threadId, 'identified')`.

### 5. Review Band — Placement Review Task, no registry interaction in the pipeline

Per ADR-0015, the pipeline does none of the Write Band's registry work. It instead creates one task via `WorkspaceStore.createTasks` (called directly, the same way `after-agent.ts` already calls other services directly rather than through a LangChain tool wrapper):

```ts
store.createTasks([
  {
    workspaceId: scope-derived workspaceId, or null for a global/non-workspace thread,
    title: `Wiki placement: ${extract.title}`,
    description: [self-contained: extract.title, extract.body, extract.tags, extract.type,
      the candidate domainId and its fitScore, and the rawSource text/threadId for provenance —
      everything the task's own run needs, with no reliance on this conversation's memory],
    assignedTo: 'agent',
    origin: 'agent',
    // no trigger: runs immediately once queued
  },
]);
getTaskScheduler().wake();
```

The `workspaceId` follows the same resolution the pipeline already did to compute `scope` — a workspace-chat or workspace-scoped task thread produces a workspace-scoped Placement Review Task; a global chat/wiki thread produces a global one (`workspaceId: null`, already a supported shape per `NewTaskInput`).

When that task's own run fires, it is an ordinary task-agent turn with full wiki tool access (`wiki_locate`/`wiki_orient`/`wiki_search`/`wiki_create_page`/`wiki_update_page`, the same `wiki_navigation` system-prompt guidance a live chat turn gets — not a constrained picker). Its description tells it to call `ask_user`, present the tentatively-matched domain and its Domain Fit Score, and ask the human to confirm it, pick a different domain, or drop the content; once answered, it performs the write itself (or does nothing, if the answer is "drop") through the ordinary write tools, subject to the same `resolveWikiWriteScope` check as any other write.

Outcome: `setAfterAgentDone(threadId, 'identified', { disposition: 'review' })`. No `wiki_updated` event — nothing was written yet.

### 6. Drop Band — existing no-op path

Same bucket the pipeline already uses for "classify said no" / "unknown domainId" / "no domains available": `setAfterAgentDone(threadId, 'no-op')`, no registry interaction, no provenance saved. No new code path — just one more condition reaching the existing branch.

### 7. `AfterAgentState` gains `disposition`

`lib/llm-common-types/src/chat/broadcast-events.ts`'s `identified` outcome variant gains an optional `disposition: 'written' | 'review'` field (present only when `outcome === 'identified'`). `outcome` stays exactly `'identified' | 'no-op' | 'error'` — no fourth value. The UI's after-agent indicator can use `disposition` to show "saved to wiki" vs. "waiting on you" without any new outcome to branch on.

## Error handling

| Case                                      | Behavior                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `extract` returns `fitScore` outside 1–10 | Schema validation already covers this (same posture as `domainId`/`type` validation today)                                                    |
| Locked Scope, any `fitScore`              | Always Write Band — gate doesn't apply                                                                                                        |
| Review Band, `store.createTasks` throws   | Logged, `setAfterAgentDone(threadId, 'no-op')` — same "never throw back into the hook" posture as every other failure branch in this pipeline |
| Drop Band                                 | `no-op`, identical to today's other no-op branches                                                                                            |
| Placement Review Task's own run           | An ordinary task-agent turn — existing task failure/retry handling applies unchanged, no new behavior                                         |

## Testing

Per the project's EDD rule, failing eval scenarios land before the code that makes them pass.

### Eval harness gap: numeric comparator

`lib/evaluations/src/schemas.ts`'s `StructuredScenarioSchema.fieldChecks[].match` supports `equals` / `contains` / `exists` / `oneOf` — nothing that can assert "`fitScore` is in the Write Band" or "`fitScore` is below 5". Add two comparators:

- `gte` — `value` is a number; passes when the resolved field is `>=` it.
- `between` — `value` is `[min, max]`; passes when the resolved field is within range, inclusive.

`lib/evaluations/src/executors/structured.ts`'s `runStructured` gains branches for both, mirroring the existing `equals`/`contains`/`exists`/`oneOf` handling. Extend `lib/evaluations/test/unit/executors/structured.test.ts` for both new comparators (in-range, below-range, above-range, boundary values).

### `suites/after-agent.yaml` scenarios

New `structured` scenarios for `extract`, reusing the existing fixture style (literal rendered prompt text from `buildExtractPrompt`):

- `ext-006-fit-score-high-for-clear-match` — a fixture whose content obviously belongs in its one candidate domain → `fitScore between [8, 10]`.
- `ext-007-fit-score-low-for-poor-match` — the `hateos-url-manager`-shaped case: a software dependency-audit turn with only unrelated personal-topic domains as candidates (e.g. `user`, `writing-worldbuilding`) → `fitScore between [1, 4]`. This is the regression scenario for #333 itself.
- `ext-008-fit-score-mid-for-plausible-but-uncertain-match` — a fixture that could plausibly belong to a candidate domain but isn't a clean fit → `fitScore between [5, 7]`.

New `tool-sequence` scenario in `suites/after-agent.yaml` (or a small addition if one already covers task creation elsewhere):

- `after-006-review-band-creates-placement-review-task` — seed a Review Band `extract` result under Open Scope; assert a task is created with `assignedTo: 'agent'`, no trigger, and a description containing the extracted title/body/candidate domain/fitScore; assert no `wiki_create_page`/`wiki_update_page` call happens in the same pipeline run.
- `after-007-locked-scope-ignores-fit-score` — seed a low `fitScore` under Locked Scope; assert the write still commits (Write Band path), confirming the gate doesn't apply.

### Developer tests

- `api/src/agents/after-agent.test.ts` `[unit]`: a pure `fitScoreBand(score)` → `'write' | 'review' | 'drop'` helper, one test per band plus both boundaries (4/5 and 7/8).
- `api/src/agents/after-agent.test.ts` `[orchestration]`: Write Band still calls `ingestPrep`/`saveRawSource`/commit (regression, unchanged path); Review Band calls `store.createTasks` with a self-contained description and makes no registry calls; Drop Band makes neither; Locked Scope with a low `fitScore` still writes.
- `api/src/services/workspace-store.test.ts`: no change expected — `createTasks`/`NewTaskInput` already support a `null` `workspaceId`; this spec is a new caller, not a new capability.

## Documentation

- `docs/Design/2026-07-17-afteragent-middleware-design.md`: no change — this spec extends the pipeline's `extract` step and post-`extract` branching, described there as "4 focused structured-output LLM calls," which stays true (still 2–4 calls; the Review/Drop Band paths just stop one step earlier).
- `TODO_LIST.md`: add an entry once implementation lands, per existing convention.
