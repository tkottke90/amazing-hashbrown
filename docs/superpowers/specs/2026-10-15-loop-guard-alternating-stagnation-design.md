# Loop Guard: Alternating-Tool Stagnation Detection — Design

**Date:** 2026-10-15
**Status:** Draft
**Related:** [Issue #301](https://github.com/tkottke90/amazing-hashbrown/issues/301), [Issue #266](https://github.com/tkottke90/amazing-hashbrown/issues/266), [2026-10-05 loop-guard design](./2026-10-05-loop-guard-stagnation-reflection-design.md)

---

## Goal

Close a blind spot in the loop guard's stagnation detector (`recursion-guard.middleware.ts`): a model that alternates between two or more tools, each call resolving to materially the same information as a recent prior call, should trip the cheap early nudge well before the much more expensive raw-streak ceiling.

---

## Problem

`computeStagnationStreak` walks backward from the most recent `ToolMessage` and counts a **strictly consecutive** run sharing the same tool name and normalized output. It stops at the first entry that doesn't match — including a call to a *different* tool, even one that is equally unproductive.

A real production incident (task `ba9c5f3a-22df-4b07-b16e-a35776663ba7` and 6 sibling runs under the same epic) hit exactly this shape: the model alternated `git status`/`git log` → `wiki_locate` → `git status`/`git log` → `wiki_locate`, each call returning materially the same result as its own last call. Because the tools alternate, the same-tool trailing run never exceeds 1, so `stagnationNudgeThreshold` (default 3) never fires. The only detector that *can* see this shape is `computeRawStreak` — consecutive tool-call turns regardless of tool or output — which fires at `streakReflectionThreshold` (default 10). Confirmed from production data: across 7 affected runs, every one hit the guard at exactly `llmCallCount == 10`, by which point the run's effective budget was already spent.

---

## Non-goals

- Changing `computeRawStreak`, the reflection mechanism, the escalation ladder, or any config field's meaning. This is a change to one detector's counting logic only.
- New configuration. The fix reuses `stagnationNudgeThreshold` / `stagnationReflectionThreshold` exactly as they exist today — no new threshold, no new window-size field.
- Semantic/embedding similarity between outputs. Matching stays the existing exact-after-normalization comparison (`normalizeToolOutput`); this issue is about *which calls are compared*, not *how* two outputs are compared.
- Oscillation between tools that each return genuinely different, useful output. That remains undetected by design — it's not stagnation.

---

## Design

### The core change: gap-tolerant matching, anchored to the most recent call

`computeStagnationStreak` currently requires the matching prior call to be *immediately adjacent*. The fix makes it **gap-tolerant**: it still anchors to the most recently called tool and its output, but when scanning backward for prior matches, it skips over intervening calls to *other* tools instead of stopping at them. A call only breaks the scan if it reaches the window boundary (see below) — not merely because a different tool was called in between.

This is a minimal generalization of the existing algorithm, not a new parallel mechanism:

- **Anchor:** the last `ToolMessage`'s tool name and normalized output — exactly as today.
- **Scan:** walk backward through the full message list (not just the pre-filtered `ToolMessage` array, so the window boundary below is visible). For each `ToolMessage` encountered, increment the count if it has the same tool name and normalized output as the anchor; otherwise leave it alone and keep scanning (do not stop). An `AIMessage` carrying a tool call is a pass-through, not a boundary.
- **Window boundary:** stop scanning at the first plain-text `AIMessage` (no tool calls) or `HumanMessage` — the same boundary `computeRawStreak` already uses to define "the current unbroken run of tool-call turns." This bounds the scan to the current streak instead of reaching arbitrarily far back into the conversation.

Anchoring to **the most recently called tool's own count** (rather than, say, a map of every tool's count with the maximum reported each turn) is the detail that keeps the nudge's "fires exactly once as the count crosses the threshold" property intact. A multi-tool max would let the reported count sit flat at the threshold value across several subsequent turns (while unrelated tools are called in between), causing the nudge to spuriously re-fire on each of those turns. Anchoring to the just-called tool avoids that: the count only changes on a turn where that specific tool is called again, so it still only passes through the threshold value exactly once per genuine crossing — the same guarantee the equality check (`stagnationStreak === cfg.stagnationNudgeThreshold`) already relies on today.

### Why this is additive, not a replacement

For the pure non-interleaved case — the only case today's code handles — the gap-tolerant scan finds zero gaps and produces an identical count and identical trigger points to the current implementation. The existing single-tool trailing-run detection is therefore a special case of the generalized algorithm, not something that needs to keep living side-by-side with it. This will be proven with explicit parity tests (see Testing) rather than asserted.

### Worked example (the production shape)

```
git status (output A) → wiki_locate (output B) → git status (output A) → wiki_locate (output B) → git status (output A)
```

- Call 3 (`git status`, output A): anchor is `git status`/A; scanning back, call 2 (`wiki_locate`) doesn't match but doesn't stop the scan; call 1 (`git status`/A) matches → count = 2.
- Call 4 (`wiki_locate`, output B): anchor is `wiki_locate`/B; call 3 doesn't match, call 2 (`wiki_locate`/B) matches → count = 2.
- Call 5 (`git status`, output A): anchor is `git status`/A; matches at call 3, then call 1 → count = 3 → **equals `stagnationNudgeThreshold` (default 3) → nudge fires**, 7 calls earlier than the raw-streak ceiling (10) that caught this in production.

### Message wording

The nudge message currently reads "You've called `X` N times **in a row**..." — accurate only for the non-interleaved case. It changes to drop the "in a row" claim so it reads correctly either way:

> "You've called `X` N times recently with materially the same result. Before trying again: state what you've actually confirmed so far, and either try a clearly different approach or conclude the investigation."

No other behavior of the nudge changes.

### Reflection is unaffected

`stagnationStreak === cfg.stagnationReflectionThreshold` uses the same (now gap-tolerant) count, so reflection triggers earlier for the alternating case for the same reason the nudge does — no change to the reflection call itself. The `recentToolCalls` slice fed to `evaluateLoopProgress()` (`toolMessages.slice(-k)`) is unchanged and, for the alternating case, now naturally shows the interleaved pattern to the judgment call.

`computeRawStreak` is untouched — it remains the backstop for a long streak with zero repeats at all.

---

## Testing

### Unit (`api/src/agents/recursion-guard.middleware.test.ts`)

- **Parity (regression):** every existing non-interleaved stagnation scenario (trailing run counts, resets on different tool, resets on different output, timestamp normalization) produces the same count and the same trigger points as before.
- **Alternating-tool stagnation:** two tools alternating, each repeating its own prior output, trips the nudge at `stagnationNudgeThreshold` and reflection at `stagnationReflectionThreshold` — reproducing the worked example above.
- **No false positive:** two (or more) tools alternating with *genuinely different* output each call never trips stagnation (only `computeRawStreak`, unchanged, can still catch that shape at its own higher threshold).
- **Window boundary:** a plain-text `AIMessage` or a `HumanMessage` between two otherwise-matching calls to the same tool resets the count to 1 — the scan does not reach back across it.
- **Nudge fires once:** in an alternating sequence where one tool's count sits at the threshold while other tools are subsequently called, the nudge does not re-fire on those later turns (only on the turn where that tool's own count actually crosses the threshold).

### Orchestration (`api/src/agents/loop-guard.integration.test.ts`)

- New test reproducing the production incident's shape end-to-end through the real middleware (`git status`/`git log` ↔ `wiki_locate`, stable outputs): asserts the nudge fires at the configured threshold, well before `streakReflectionThreshold`'s call count.

### Eval

None required. This is a deterministic change to a counting function's inputs, not a change to how the model is expected to respond to a nudge or reflection prompt (that behavior, and its eval coverage in `suites/loop-guard.yaml`, is unchanged) — so the EDD rule to write a failing eval scenario first doesn't apply here. Correctness is fully covered by the deterministic unit and orchestration tests above.

---

## Files Changed

| File | Change |
| --- | --- |
| `api/src/agents/recursion-guard.middleware.ts` | Generalize `computeStagnationStreak` to a gap-tolerant scan bounded by the same window boundary `computeRawStreak` uses; reword the nudge message to drop "in a row" |
| `api/src/agents/recursion-guard.middleware.test.ts` | New alternating-tool tests, false-positive test, window-boundary test, fires-once test; parity tests for the existing non-interleaved cases |
| `api/src/agents/loop-guard.integration.test.ts` | New end-to-end test reproducing the production alternating-tool shape |
