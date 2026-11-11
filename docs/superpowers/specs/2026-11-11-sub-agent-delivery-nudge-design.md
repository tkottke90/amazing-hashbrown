# Sub-agent Delivery Nudge: reserve budget for a deliverable instead of hard-stopping mid-exploration

Issue: #411

## Problem

A `spawn_sub_agent` Run's `escalationMode: 'throw'` loop guard (`recursion-guard.middleware.ts`)
ends the Run the instant any of its three triggers crosses — with no reserved turn for the model to
actually write up what it found. See GLOSSARY.md § Loop Guard for Stagnation Streak / Raw Streak /
Stagnation Nudge / Reflection / Converging, and § Task Runs for Stalled Run / Exhausted Run — the
vocabulary this design extends and the taxonomy its new outcome joins. ADR-0062 covers why this is
an in-Run fix rather than a cross-run retry, and the exact numbers behind the step-count trigger's
grace window; this spec covers the resulting mechanism end to end.

## Mechanism

### The two-rung structure, per trigger

| Trigger | First crossing → Delivery Nudge | Real throw → Loop-Guard Exhaustion |
|---|---|---|
| Step-count check-in | `stepThreshold` (`subAgentRecursionLimit * warnThreshold`, 18 at today's defaults) | `subAgentRecursionLimit` itself (25) — not the next periodic multiple (see ADR-0062) |
| Reflection, Stagnation Streak | First non-Converging verdict | Next reflection call on the same streak, if still non-Converging |
| Reflection, Raw Streak | First non-Converging verdict | Next reflection call on the same streak, if still non-Converging |

One shared Delivery Nudge message text across all three triggers — the model doesn't need a
different framing depending on which counter caught it.

### Marking "already nudged" vs. a fresh crossing

The Delivery Nudge is injected as a `HumanMessage` tagged with a dedicated marker (parallel to the
existing `NUDGE_MARKER`, but its own distinct `loopGuardKind`, scoped per trigger — step-count,
stagnation, and streak each track their own one-shot nudge independently). Unlike the Stagnation
Nudge's marker, the Delivery Nudge's marker does **not** need special-casing in
`isStagnationWindowBoundary` — a Delivery Nudge is meant to act as a genuine boundary (we want
Stagnation Streak/Raw Streak counted fresh from after the nudge, not blended with pre-nudge churn),
and the function's existing default (any `HumanMessage` not tagged with the Stagnation Nudge's own
`loopGuardKind` is a boundary) already does the right thing.

For step-count: once its marker is present (nudged at 18), check on *every* subsequent
`beforeModel` call — not just at the next multiple of `stepThreshold` — whether `completedSteps`
has reached `subAgentRecursionLimit` (25). `subAgentRecursionLimit` isn't guaranteed to land on a
multiple of `stepThreshold` for every possible config, so this has to be a plain `>=` check against
the fixed ceiling, not a second periodic crossing. If reached: check delivery (below) and either
let the Run continue (delivered) or throw Loop-Guard Exhaustion (not delivered). Before the marker
is present at all, the existing periodic check (`completedSteps % stepThreshold === 0`) still
governs the *first* crossing, which injects the Delivery Nudge instead of throwing.

For Reflection (Stagnation Streak, Raw Streak): once a trigger's marker is present from a first
non-Converging verdict, the *next* time Reflection runs on the same streak and judges it still
non-Converging is the real, second crossing — check delivery and either continue or throw. This one
genuinely is "wait for the next occurrence," since Reflection only runs when its own threshold is
hit again, not on every `beforeModel` call.

### Detecting delivery

A `hasDelivered: () => boolean` closure, threaded into `createRecursionGuardMiddleware`'s options
the same way `taskId`/`evaluateLoopProgress` already are, backed by the same `hooks.onTaskComplete`
wiring `buildSubAgentAgent` passes through from `task-execution.ts`'s `completeTaskBox`. This is
the only delivery path the guard needs to check: a plain-text reply with no tool call needs no
guard-side detection, since the graph already reaches its own normal END before `beforeModel` could
re-fire — it simply never reaches the second-crossing check at all. A tool call to anything other
than `complete_task` does not count as delivered and proceeds straight to the real throw on a
second crossing.

As a side effect, this also fixes a pre-existing race: today, an accepted `complete_task` call
followed by the model's own courtesy reply (the standard ReAct loop's one extra round-trip after
any tool call) could land exactly on a threshold crossing and discard an already-successful
completion. Checking `hasDelivered()` before ever throwing — on *either* rung — closes that gap too.

### Outcome classification (unchanged on one path, new on the other)

- **Plain-text reply after a Delivery Nudge, no `complete_task` call**: falls through to today's
  existing Stalled Run `failed`/`other` path unchanged — the agent's text is already preserved as
  the Run's summary; no new outcome invented for "replied in prose instead of calling the tool."
- **Real throw (second crossing, nothing delivered)**: `failure_reason: 'loop_guard_exhausted'`
  (GLOSSARY.md § Task Runs — Loop-Guard Exhaustion), a plain `TEXT` column already (`workspace-store.ts`),
  no migration needed. The parent notification (`sub-agent-notification.ts`'s
  `buildNotificationMessage`) gets distinguishing wording for this case specifically — something to
  the effect of "asked to wrap up and still produced nothing before its budget ran out" — rather
  than reusing the raw `StagnationLimitError.summary` string or lumping it in with a genuine Stalled
  Run's "stopped for no detected reason."

### `subAgentRecursionLimit` becomes a real ceiling

For `origin: 'agent'` runs specifically, pass `subAgentRecursionLimit` (not the shared
`env.agent.recursionLimit`) as the `recursionLimit` in the `streamEvents()` config
(`task-execution.ts`'s one shared call site). See ADR-0062 for why this has to land at the same
number the step-count trigger's real-throw point uses.

## Out of scope

- `system-prompt.ts` / `SPAWN_SUB_AGENT_SECTION` — this is a harness-only fix; no change to how the
  parent is told to scope a `spawn_sub_agent` goal.
- Any UI surfacing — Sub-Agent Tasks never reach the board or Task Drawer either way (ADR-0055), so
  neither the Delivery Nudge nor Loop-Guard Exhaustion needs a UI component; the only surfaces are
  `task_queue.failure_reason` and the parent-thread notification text.
- `escalationMode: 'interrupt'` (chat/task runs) — untouched; a human's own "continue or stop"
  choice at the same thresholds already covers this differently for those runs.

## Also in this change: AfterAgent removed from sub-agent Runs

Unrelated to the budget mechanism above, but shipping in the same change: `afterAgentMiddleware` is
removed from `buildSubAgentAgent`'s middleware tuple entirely. See ADR-0063 for the full reasoning
and GLOSSARY.md § Sub-Agent Task / § AfterAgent & Wiki Write Scope for the vocabulary. No further
detail here — ADR-0063 is the complete record of this decision.

## Testing

Per root `AGENTS.md`: every new behavior here (both Delivery Nudge rungs for all three triggers,
`hasDelivered` detection, the `subAgentRecursionLimit` ceiling change, the `loop_guard_exhausted`
failure_reason, the notification wording, and the AfterAgent-removal change) needs Unit coverage in
`recursion-guard.middleware.test.ts` / `chat-agent.test.ts` / `task-execution.test.ts` /
`sub-agent-notification.test.ts` as applicable, following this repo's existing test-type tagging
convention. No E2E coverage needed — this is non-UI, non-board-visible behavior.
