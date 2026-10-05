# Loop Guard: Stagnation Detection and Reflection — Design

**Date:** 2026-10-05
**Status:** Draft
**Related:** [Issue #266](https://github.com/tkottke90/amazing-hashbrown/issues/266), [Issue #267](https://github.com/tkottke90/amazing-hashbrown/issues/267)

---

## Goal

Extend the existing `recursion-guard.middleware.ts` so it also catches two failure modes its current step-counter cannot see — a tool call repeating itself with no new information, and a long unbroken run of tool calls with no pause to explain itself — and responds with an escalating ladder (**nudge → reflect → escalate**) instead of letting the turn run until it exhausts the recursion budget.

---

## Problem

Agents can get stuck running many tool calls — most commonly `shell_exec` with slightly varied read-only commands (`grep`, `ls`, `cat`, `find`) — that keep returning the same or no new information. A reviewed thread (CRON task testing in the `cron-test` workspace) showed this twice in one session: ~20 near-identical `grep` calls chasing a literal `"Abort"` string across three turns with no new findings, and later a single turn re-running `ls -la && cat log.jsonl` / `find .hashbrown -type f` three times back to back with byte-identical results each time. Neither was caught by anything in the harness.

**Correction carried forward from #266's own discussion:** interactive chat and headless task runs (`buildChatAgent` / `buildTaskAgent`) both already wire in `createRecursionGuardMiddleware`, and a `GraphInterrupt` thrown from it is already handled correctly in both — `task-execution.ts` catches it, parks the run as `waiting_on_user`, and a human can answer later through the task's own `/hitl` route. That path is not broken and does not need to change. The genuine gap is **sub-agent runs** (`buildSubAgentAgent`): they have no recursion-guard middleware at all today, because `interrupt()` has nothing to resume it in a sub-agent dispatch — there's no `/hitl` route, no later-answerable park, nothing watching.

This design extends the existing middleware to add two new trigger signals (stagnation, raw streak) on top of the existing step-count check-in, and adds the middleware — in a different, non-`interrupt()` escalation mode — to sub-agent runs for the first time.

---

## Non-goals

- Oscillation between _different_ tools that each individually look fine (e.g. bouncing between two tools with no shared state ever changing). That's a design-time tool-description problem, not something a runtime counter can reliably catch. Not handled here.
- Semantic/embedding similarity for detecting "similar" tool calls — considered and rejected (see the issue discussion): it's imprecise in the direction that matters (genuinely different commands probing different files can both be unproductive, while scoring as dissimilar) and swaps a deterministic, unit-testable check for a non-deterministic model-distance threshold.
- Changing the existing step-count check-in's behavior, thresholds, or UI. It is untouched — stagnation and streak are two additional, independent signals checked in the same `beforeModel` hook.
- Tuning the exact default threshold values to a final, validated number. Defaults below are starting points; Issue #266's own dev notes already call out shipping observability ahead of behavior change so real data can inform tuning. This design only commits to the mechanism and a reasonable starting point.

---

## Key Design Insight: An Escalation Ladder, Not a Second Guard

Early framing for this treated "fingerprint and nudge" and "periodic reflection" as parallel, independently-timed mechanisms. They are not — they are rungs of one ladder, with two different entry conditions feeding the same middle rung:

1. **Nudge** — a deterministic, zero-extra-cost tripwire. Fires once when a tool's output has stagnated (same tool, materially the same output, N times in a row). No model judgment is needed here: repeated identical output is already objective evidence nothing new is happening.
2. **Reflection** — a genuine judgment call, reached two ways: stagnation persisting past the nudge (the nudge didn't help), or a long streak of tool calls accumulating with **no repeats at all** (every call looks different, so stagnation never trips, but nothing has paused to explain itself either — this is the shape the real "Abort" investigation took). Because "is 10 different-looking tool calls actually converging" is not something a counter can answer, reflection is a real, separate LLM call — structurally the same pattern the existing `afterAgentMiddleware` already uses (its own small, scoped prompt, not the main model grading its own work).
3. **Escalate** — reached only if reflection's own verdict says the run isn't converging. No additional magic-number threshold is needed at this rung; the reflection call's judgment is the gate. What escalation _does_ is the one place context matters: chat and task runs reuse the existing `interrupt()`-and-park pattern (already correct); sub-agents — which have no park-and-resume path — stop the run and report back to the parent, the same way a task reports back to the user.

---

## Design

### 1. Configuration

Extends the existing `AgentSchema` (`api/src/config/env.ts`), alongside `recursionLimit` / `recursionWarnThreshold` / `subAgentRecursionLimit`:

```typescript
export const LoopGuardSchema = z.object({
  enabled: z.boolean().default(true),
  stagnationNudgeThreshold: z.number().int().positive().default(3),
  stagnationReflectionThreshold: z.number().int().positive().default(5),
  streakReflectionThreshold: z.number().int().positive().default(10),
});

export const AgentSchema = z.object({
  recursionLimit: z.number().int().positive().default(100),
  recursionWarnThreshold: z.number().min(0.1).max(0.99).default(0.75),
  subAgentRecursionLimit: z.number().int().positive().default(25),
  loopGuard: LoopGuardSchema.default({}),
});
```

```yaml
agent:
  loopGuard:
    enabled: true
    stagnationNudgeThreshold: 3 # consecutive same-tool/same-output calls -> nudge
    stagnationReflectionThreshold: 5 # same streak persisting past the nudge -> reflect
    streakReflectionThreshold: 10 # consecutive tool-call turns, any tools, no plain reply -> reflect
```

`stagnationReflectionThreshold` must be validated as `> stagnationNudgeThreshold` (zod `.refine()` on `LoopGuardSchema`), mirroring the validation style already used elsewhere in `env.ts` for related numeric fields.

**Feature flag:** `agent.loopGuard.enabled` is the config-level default. Whether it also needs a per-request `context.loopGuardEnabled` override (mirroring `afterAgentEnabled`'s shape, passed at the `agent.streamEvents()` call sites) should be confirmed at implementation time against how `afterAgentEnabled`'s override actually resolves today — not fully traced as part of this design.

### 2. Signal detection (derived from `state.messages`, no new persisted state)

Added to `recursion-guard.middleware.ts`'s existing `beforeModel` hook, computed fresh each call — the same pattern the existing step counter already uses (`state.messages.filter(isAIMessage).length`), so neither new signal needs out-of-band bookkeeping or anything to lose on a resume.

**Stagnation streak:** walking backward from the most recent `ToolMessage`, count consecutive entries that share the same tool name and a _normalized_ output (trim whitespace, strip ISO-8601 timestamp substrings via regex) equal to the most recent one. Stop at the first entry that doesn't match.

**Raw streak:** count consecutive tool-call turns (an `AIMessage` carrying a tool call, followed by its `ToolMessage`) since the last plain-text assistant reply or the last `HumanMessage`. Resets on either.

Both checks run unconditionally on every `beforeModel` call when `loopGuard.enabled` is true; the existing step-count check is unaffected and continues to run independently in the same hook.

### 3. Nudge

Fires exactly once per growing stagnation streak, at `stagnationStreak === stagnationNudgeThreshold` (equality check, same "fire at a specific point, not every subsequent call" style the existing step-count comment already documents). No extra LLM call — injects a `HumanMessage`, the same mechanism the existing code already uses for non-"Continue working" answers:

```typescript
if (stagnationStreak === cfg.stagnationNudgeThreshold) {
  return {
    messages: [
      new HumanMessage(
        `You've called \`${toolName}\` ${stagnationStreak} times in a row with ` +
          `materially the same result. Before trying again: state what you've ` +
          `actually confirmed so far, and either try a clearly different ` +
          `approach or conclude the investigation.`,
      ),
    ],
  };
}
```

### 4. Reflection

A new, separate, small LLM call — `evaluateLoopProgress()` in a new sibling file `api/src/agents/loop-reflection.ts` (kept out of the middleware file itself, same separation `after-agent.ts`'s multi-step pipeline keeps from `chat-agent.ts`). Triggered when either:

- `stagnationStreak === stagnationReflectionThreshold` (nudge didn't resolve it), or
- `rawStreak === streakReflectionThreshold` (no repeats, but a long unbroken run with no check-in)

It is given the last K tool-call/result pairs — K equal to whichever streak triggered it (`stagnationReflectionThreshold` or `streakReflectionThreshold`), capped at 15 regardless, so a high configured threshold can't balloon the reflection prompt — and asks a single structured question: is this converging? Uses `createProvider()` for its own model instance and `resolveTurnModel` / `startTurnObservability` for tracing, the same helpers `after-agent.ts` already composes rather than hand-rolling a callback handler — so it shows up in thread reports as its own named span (`loop-guard:reflect`), the same way `after-agent:summarize` etc. already do.

```typescript
const ReflectionResult = z.object({
  converging: z.boolean(),
  summary: z.string(),
  guidance: z.string().optional(),
});
```

- `converging: true` → inject `guidance` as a `HumanMessage`, reset both the stagnation and raw streak counters (the reflection itself is the "break").
- `converging: false` → escalate, using `summary` as the park/report reason.

Only reflection resets the counters. The nudge (step 3) is a one-time trip at its threshold and resets nothing — it is itself an injected `HumanMessage`, not a plain assistant reply, so the raw streak keeps counting through it exactly as it would through any other tool-call turn. This is deliberate: a nudge that silently reset the raw streak counter would let a model that ignores nudges run indefinitely without ever reaching reflection via that path.

### 5. Escalation (context-aware)

**Chat and task runs:** unchanged mechanism — call `interrupt()` with a new HITL kind (see below), which `task-execution.ts` and the interactive stream handlers already know how to catch, park, and resume via `recoverThrownInterrupt` / the existing resume path.

**Sub-agents (net-new):** `buildSubAgentAgent` gains the loop-guard middleware for the first time, configured in a distinct escalation mode that throws instead of interrupting:

```typescript
export class StagnationLimitError extends Error {
  constructor(
    public readonly summary: string,
    public readonly reason: 'stagnation' | 'streak',
  ) {
    super('Stagnation limit reached');
    this.name = 'StagnationLimitError';
  }
}
```

Thrown and caught by name-string match, the same convention `task-execution.ts` already uses for `GraphInterrupt` (`(err as Error).name === 'StagnationLimitError'`) rather than `instanceof` — consistent with that file's existing comment on why name-matching is preferred there. The new catch branch routes straight to the existing `deliverSubAgentCompletion(task, 'failed', summary)` — the same reporting path a cancelled sub-agent run already uses, so the parent agent receives the stagnation reason exactly like any other sub-agent failure.

### 6. New HITL prompt kind

```typescript
export interface HitlPromptFields {
  // ...existing fields...
  promptKind:
    | 'yes_no'
    | 'multiple_choice'
    | 'free_text'
    | 'shell_approval'
    | 'recursion_limit_warning'
    | 'loop_stagnation_warning'; // new
  summary?: string; // loop_stagnation_warning only — the reflection call's own summary
}
```

Rendered by the existing `multiple_choice`-capable `hitl-prompt-message.tsx` component with `summary` surfaced as a subheading, the same way `recursion_limit_warning` already surfaces `stepsUsed`/`recursionLimit` — no new UI component, a small addition to the existing one.

---

## Data Flow

**Happy path:** both new counters sit below every threshold on every call; the middleware returns `undefined`, same as today.

**Stagnation, nudge resolves it:** streak hits the nudge threshold → `HumanMessage` injected → model's next tool call differs or stops → streak resets → no further action.

**Stagnation, nudge doesn't resolve it:** streak keeps growing past the nudge point → hits the reflection threshold → `evaluateLoopProgress()` runs → `converging: false` → escalate (interrupt-and-park for chat/task, `StagnationLimitError` for sub-agent).

**Long streak, no repeats:** raw streak hits its own threshold with zero stagnation ever detected → `evaluateLoopProgress()` runs directly → `converging: true` → guidance injected, both counters reset, turn continues; or `converging: false` → escalate, same as above.

**Sub-agent escalation:** `StagnationLimitError` thrown → caught in `task-execution.ts`'s existing catch chain (new named branch, alongside `GraphInterrupt`) → `deliverSubAgentCompletion(task, 'failed', summary)` → parent agent sees the sub-agent's completion with the stagnation reason, same shape as any other sub-agent failure it already handles.

---

## Testing

### Unit (`api/src/agents/recursion-guard.middleware.test.ts`, `loop-reflection.test.ts`)

- Stagnation streak counting: resets on different tool name, resets on different normalized output, counts correctly across a timestamp-only difference.
- Raw streak counting: resets on a plain-text reply, resets on a `HumanMessage`, counts correctly across mixed tool names.
- Threshold firing: nudge fires exactly once at the threshold, not on every subsequent call; reflection fires at its own threshold via either entry path.
- `evaluateLoopProgress()`: given a stubbed model response, correctly routes `converging: true` to injected guidance + reset, and `converging: false` to the escalation signal — no real model call in this test.

### Orchestration

- `task-execution.ts`: a thrown `StagnationLimitError` for a `task.origin === 'agent'` run calls `deliverSubAgentCompletion` with `'failed'` and the reflection summary; a non-sub-agent task run with the same error still parks correctly if it somehow reaches that path (defensive case — sub-agent mode shouldn't fire for a top-level task, but the branch shouldn't crash if it does).
- `finalizeTurn()` / HITL dispatch: a `loop_stagnation_warning` interrupt is recorded and emitted the same way `recursion_limit_warning` already is.

### Eval (new `suites/loop-guard.yaml`, `tool-sequence` scenarios)

Seeds N synthetic prior tool-call/result pairs directly into the conversation (the harness's existing `tool-sequence` mechanism), then asserts the model's next turn actually changes behavior once the nudge or reflection guidance is present — not just that the counters fired, but that the model responds to being nudged. This is the layer that validates the ladder does its actual job, as opposed to the unit tests validating only the counting logic.

---

## Files Changed

| File                                                | Change                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api/src/config/env.ts`                             | Add `LoopGuardSchema` / `agent.loopGuard` config block                                                                                                                         |
| `api/src/agents/recursion-guard.middleware.ts`      | Add stagnation + raw streak detection, nudge injection, reflection trigger, escalation branch (interrupt vs. throw); export `StagnationLimitError`                             |
| `api/src/agents/loop-reflection.ts`                 | New file — `evaluateLoopProgress()`, the reflection LLM call                                                                                                                   |
| `api/src/agents/chat-agent.ts`                      | `buildSubAgentAgent` gains the loop-guard middleware (new), configured in throw-mode; `buildChatAgent`/`buildTaskAgent` calls updated in place (no new wiring, same call site) |
| `api/src/agents/task-execution.ts`                  | New catch branch for `StagnationLimitError` → `deliverSubAgentCompletion(task, 'failed', summary)`                                                                             |
| `api/src/agents/thread-message-writer.ts`           | Add `'loop_stagnation_warning'` to `promptKind`, add `summary?` field                                                                                                          |
| `lib/llm-common-types/src/chat/hitl.ts`             | Same `HitlPromptFields` additions on the shared type                                                                                                                           |
| `ui/src/components/hitl-prompt-message.tsx`         | Surface `summary` as a subheading for `loop_stagnation_warning`, same pattern as `recursion_limit_warning`                                                                     |
| `suites/loop-guard.yaml`                            | New eval suite — `tool-sequence` scenarios seeding stagnant/streak tool-call histories                                                                                         |
| `api/src/agents/recursion-guard.middleware.test.ts` | New stagnation/streak/threshold unit tests                                                                                                                                     |
| `api/src/agents/loop-reflection.test.ts`            | New unit tests for `evaluateLoopProgress()`                                                                                                                                    |
| `api/src/agents/task-execution.test.ts`             | New orchestration test for the `StagnationLimitError` branch                                                                                                                   |
