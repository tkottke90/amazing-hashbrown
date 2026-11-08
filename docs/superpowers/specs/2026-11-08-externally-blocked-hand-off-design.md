# Externally-blocked task hand-off — design

Issue: [tkottke90/amazing-hashbrown#367](https://github.com/tkottke90/amazing-hashbrown/issues/367)

## Problem

A Task's Run can determine that its only remaining blocker is something only
the user can clear (an OAuth consent flow, a credentials file, any action the
agent structurally cannot perform itself) — not limited to auth/credentials,
though that was the triggering case. Today that lands as an ordinary
`agent_requested` Handed-Off Run, indistinguishable on the board or in the
Task Drawer from a hand-off that just needs review. Nothing stops the owning
Workspace's chained `schedule_wakeup` check-ins from spawning fresh Tasks
against the same dead end on every wake, for days (observed in the
gmail-labeler workspace retrospective, 2026-10-26).

## Design

The full architectural decision — the new `awaiting_user_action` Hand-Off
Cause, the new tool vs. extending `hand_off_task`, the `handoff_reason` vs.
`blocked_reason` choice, the wake-up-cancellation mechanism, and the
drag-to-queue gating — is recorded in **ADR-0059**. GLOSSARY.md defines
**Externally-Blocked Hand-Off**, **Hand-Off Cause**, **Hand-Off Note**, and
**Hand-Off Guidance**. This document does not restate either — it's the
implementation plan for ADR-0059.

## Scope

In scope: ordinary (board-visible) Tasks only, same line as ADR-0056/0057 —
a Sub-Agent Task never reaches the board or the Task Drawer, so none of the
board-facing or Hand-Off-Guidance machinery here has anything to act on for
one. Clearing an Externally-Blocked Hand-Off is an explicit user action only
(Hand-Off Guidance, or any other existing resume path); automatic
event-driven resume (a file appearing, a webhook firing) is out of scope —
tracked as a separate follow-up issue (see "Follow-up" below).

## Implementation plan

### 1. New tool: `block_on_user_action`

New file `api/src/agents/tools/block-on-user-action.tool.ts`, a sibling to
`hand-off-task.tool.ts`. Takes a required free-text `note` (what the user
needs to do), written as the Run's `summary` — the Hand-Off Note — same as
`hand_off_task`'s existing write.

Bound **unconditionally** in a task Run's tool list (`system-prompt.ts`,
`tool-catalog.ts`), alongside `complete_task`/`ask_user`/`hand_off_task`, with
**no nudge-once gate**: `hand_off_task`'s gate requires a prior `ask_user`
interrupt in the same Run; this tool needs none, since an externally-blocked
scenario isn't one `ask_user` could resolve. Add a `system-prompt.ts` section
alongside the existing `hand_off_task` guidance distinguishing the two: use
`block_on_user_action` when no further question to the user would help
either (the blocker is outside the chat entirely), `hand_off_task` otherwise.

### 2. Write path

In `task-execution.ts`, mirror the existing `hand_off_task` write
(`task-execution.ts:779`): on `block_on_user_action`, write
`task_queue.handoff_reason = 'awaiting_user_action'` and settle the Run as
`handed_off` through the existing `completeQueueEntry('handed_off')` /
`settleTaskAfterRun()` path in `workspace-store.ts` — no change needed there;
it already settles any `handed_off` outcome to `tasks.status: 'blocked'`
regardless of `handoff_reason`'s value.

### 3. Cancel the Workspace's pending wake-up

Also in the tool's write path (`task-execution.ts`, same call site as step
2): resolve the Task's `workspaceId` → `getWorkspace(workspaceId).threadId`
→ `WakeupStore.listPending()` filtered to that `threadId` → `cancel()` for
any match. No-op when the Task is workspace-less or nothing is pending.
Extend `WakeupCancelSource` (`wakeup-store.ts`) with a new value (e.g.
`'externally_blocked_handoff'`) so a cancelled wake-up's record shows why,
consistent with the existing cancel-source tracking.

### 4. Board-rules gating

`board-rules.ts`: extend the drag-to-queue move plan to reject (409, same
pattern as the existing `exhaustion_cap` rejection) a bare drag-to-queue when
`handoff_reason === 'awaiting_user_action'` — **unconditionally**, no scope
check (unlike `exhaustion_cap`, this cause was never about repeated
identical-scope attempts).

### 5. Board-rules reason/lane

`board-rules.ts`'s `sourceOf()`: today `BoardContext.handoff` (`LatestHandoff`)
is computed but only consulted for the one narrow `exhaustion_cap` rejection
rule, never to produce its own `BoardReason` kind — a `blocked` Task from any
hand-off still renders as the generic `blocked_paused`/`paused` bucket.
Branch on `context.handoff?.handoffReason` to give `awaiting_user_action` its
own `BoardReason` kind (e.g. `blocked_awaiting_user_action`), distinct from
plain `blocked_paused`, so the Kanban board can render it differently (label/
badge) from an ordinary manual pause or an `agent_requested`/`exhaustion_cap`
hand-off.

### 6. Task Drawer

The Hand-Off Note / Hand-Off Guidance panel (ADR-0057) already generalizes
across every Hand-Off Cause, so no new panel is needed. Add a label/badge for
the new `BoardReason` kind from step 5 (e.g. "Externally blocked") so a user
opening the drawer immediately sees this is a different kind of stuck than a
manual pause or a routine hand-off, before reading the Hand-Off Note.

### 7. Follow-up

File a new GitHub issue tracking automatic event-driven clearing of an
Externally-Blocked Hand-Off (a file appearing, a webhook firing resuming the
specific Task it names) — explicitly deferred from this issue's scope per
ADR-0059.

## Testing

Per root AGENTS.md: every new tool, route, service function, and middleware
change above needs developer tests.

- **Unit**: `block_on_user_action`'s handler (writes the right `summary`/
  `handoff_reason`, no nudge-once gate); the wake-up-resolution-and-cancel
  helper (resolves workspace → thread → pending wake-up correctly; no-ops
  when workspace-less or nothing pending); the new `sourceOf()` branch and
  the new drag-to-queue rejection branch in `board-rules.ts` (follow the
  existing `board-rules.test.ts` move-table pattern).
- **Orchestration**: `task-execution.ts`'s wiring of the new tool through to
  `completeQueueEntry`/`settleTaskAfterRun` and the wake-up cancellation call
  (spy on `WakeupStore`, don't re-test its own behavior).
- **E2E**: Playwright coverage for the Task Drawer's new badge/label and the
  board's rejected drag-to-queue on an `awaiting_user_action` Task, per root
  AGENTS.md's "every PR that changes UI behaviour ships E2E coverage in the
  same PR" rule.

Per the root AGENTS.md's EDD rules: recognizing when a blocker needs
`block_on_user_action` rather than `hand_off_task` or `ask_user` is
LLM-facing behavior and needs a failing eval scenario authored before
implementation (rule 1), referencing issue #367 (rule 2). The actual eval run
is handed off to the user per EDD rule 5 — this session has no network path
to the local model providers `npm run eval` targets.
