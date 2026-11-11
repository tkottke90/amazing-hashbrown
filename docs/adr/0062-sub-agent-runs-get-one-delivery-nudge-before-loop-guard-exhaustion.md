# Sub-agent Runs get one Delivery Nudge before Loop-Guard Exhaustion, not a cross-run retry

Issue #411: a Sub-Agent Task's `escalationMode: 'throw'` loop guard killed the Run the instant any
threshold crossed — the step-count check-in, or Reflection's non-Converging verdict — discarding
real exploration work with nothing ever delivered back to the parent. ADR-0056's Narrowed
Retry/Exhaustion Cap pattern (one more attempt, then escalate) can't be reused here: a Sub-Agent
Task never reaches the board or Task Drawer for a human, or its own parent, to retry against
(ADR-0055), so there's nothing for a second dispatched Run to hang off of.

Decided: each of the loop guard's three throw triggers (step-count check-in, Reflection on a
Stagnation Streak, Reflection on a Raw Streak) gets exactly one Delivery Nudge — an injected
directive to stop investigating and call `complete_task` now — before a second, real crossing of
the same condition ends the Run as a Loop-Guard Exhaustion. Detecting whether that nudge actually
landed (a `complete_task` call was accepted) is done via a `hasDelivered` closure threaded through
the same `hooks.onTaskComplete` wiring `buildSubAgentAgent` already has, not by pattern-matching
tool output text. A plain-text reply with no tool call needs no detection at all — the graph
already ends on its own before the guard could re-fire, so it falls through to the existing
Stalled Run classification unchanged.

For the step-count trigger specifically, the real-throw point is pinned to `subAgentRecursionLimit`
itself rather than the next periodic multiple of its warn threshold — letting it float to the next
multiple (double the configured budget) would exceed `subAgentRecursionLimit`, which this change
also makes an actually-enforced hard ceiling on the underlying LangGraph `recursionLimit` for
`origin: 'agent'` runs (previously it only shaped the warn-threshold arithmetic and enforced
nothing on its own — LangGraph's real ceiling was the shared, much larger `env.agent.recursionLimit`).
Pinning the real throw to the same number the hard ceiling now enforces keeps the two from racing
each other.

## Considered Options

- Reuse Narrowed Retry/Exhaustion Cap (dispatch a second Run) — rejected: architecturally
  incompatible per ADR-0055/0056 above; there's no board-visible Task for either mechanism to act on.
- A separate, fixed "+N steps" grace constant shared across all three triggers — rejected: each
  trigger's own natural recurrence already gives a well-defined, trigger-appropriate grace window
  with no new config knob needed.
- Let the step-count trigger's grace window float to the next periodic multiple (36, at today's
  defaults) — rejected: exceeds `subAgentRecursionLimit`, which this same change enforces as a real
  ceiling, so the hard LangGraph `GraphRecursionError` would fire first and the model would never
  see the Delivery Nudge at all.
