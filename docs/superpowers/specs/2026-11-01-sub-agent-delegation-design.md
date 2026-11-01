# Sub-Agent Delegation: Encouraging Use and Making It Visible

## Context

[`spawn_sub_agent`](../../../api/src/agents/tools/spawn-sub-agent.tool.ts) exists so an
open-ended, exploratory task can run in its own disposable context and report back a
summary, instead of bloating the parent thread with the intermediate tool calls it took
to get there. In practice the model rarely reaches for it — see
[issue #267](https://github.com/tkottke90/amazing-hashbrown/issues/267), which this spec's
Track A implements.

Designing the fix surfaced a second, related gap: a Dispatch already reports back into the
parent thread (a `sub_agent_marker` message, written by `recordSubAgentMarker` in
[`thread-message-writer.ts`](../../../api/src/agents/thread-message-writer.ts)), but the UI
has no rendering for it at all, so that reporting is currently invisible to the user. Track B
closes that gap. Both tracks are designed together here because they're the same underlying
move — normalizing how Sub-Agent Dispatch behaves and is surfaced — but they ship and are
tracked independently: Track A against issue #267, Track B against a new issue filed once
this spec is committed.

Domain vocabulary used throughout (**Sub-Agent Task**, **Dispatch**, **Run**) is defined in
`GLOSSARY.md` § Sub-Agent Dispatch and § Task Runs, not restated here. The board/hand-off
exclusion this spec relies on is recorded in
[ADR-0055](../../adr/0055-sub-agent-tasks-never-surface-on-the-task-board-or-hand-off-to-a-user.md).

## Track A — Delegation heuristic

### Problem

`SPAWN_SUB_AGENT_SECTION` (`api/src/agents/system-prompt.ts:1283-1305`) only tells the model
to delegate when the user explicitly signals the task should run in the background ("go
ahead and have someone else work on it"). An open-ended investigative prompt with no such
framing — #267's own example, "find out why this task failed" — doesn't trigger it, so the
investigation runs inline instead, which is exactly the noise `spawn_sub_agent` exists to
avoid.

### Change

Rewrite the heuristic to key off the **shape** of the task rather than the user's phrasing:
the destination is clear, but the number of steps and the path to it aren't. Explicit
"run this in the background" framing remains one case that obviously qualifies — it is not
removed, just no longer the only trigger. A quick question answerable from what's already in
front of the model still doesn't need a sub-agent at all; that exception stays.

Alongside the narrative section, review `spawn_sub_agent`'s own tool description
(`spawn-sub-agent.tool.ts:11-25`) per #267's dev note — a tool description that undersells
when to use it suppresses calls the same way missing prompt guidance does.

**Acknowledgment framing:** the model's reply for the turn in which it calls
`spawn_sub_agent` must say that it has dispatched a sub-agent and will report back (the
"I have a background agent working on this" pattern). Today's guidance says nothing about
this; without it, the user sees nothing happen until a completion notification arrives later,
which reads as the question having been ignored.

**Explicitly deferred:** an instruction telling the model not to also keep investigating
inline, in the same turn, after dispatching. Flagged as a possible follow-up if the
dispatch-and-also-investigate pattern actually shows up once this ships — not added now, to
avoid system-prompt bloat for a behavior that hasn't been observed yet.

**Dropped from this change:** "planning" as an encouraged delegation case. A Sub-Agent Task
starts with zero inherited context — only the literal `goal` string, per the tool's own
schema comment (`spawn-sub-agent.tool.ts:19-24`) — so delegating "make a plan for this" means
planning from a cold start rather than from what the parent thread has already gathered.
Tracked as a follow-up issue: giving the parent agent a way to pass gathered context, or copy
part of the existing thread, into `goal`.

### Validation

A new dedicated suite, `suites/sub-agent-delegation.yaml`:

- `tool-call`/`tool-sequence` scenarios asserting delegation on representative open-ended,
  investigative prompts (no explicit "background" framing).
- A measured before/after delegation-rate comparison, reusing the tool-call counter
  introduced in #266, not an impression of whether the change worked.
- Per this repo's EDD rules, the failing scenario(s) are written before the prompt change,
  and the full suite (plus existing suites, e.g. `wiki-navigation`, which also depend on the
  shared system prompt) must pass green before merge.

### Non-goals

- No change to `spawn_sub_agent`'s fire-and-forget dispatch mechanics. Broadening the
  heuristic means more "quick ack now, real answer in a later turn" exchanges for ordinary
  investigative questions — accepted as-is; a synchronous "spawn and await inline" mode is a
  materially larger, separate change.
- No change to nesting protection — `SUB_AGENT_HARD_EXCLUDED_IDS` in `tool-config.ts` stays
  as-is. Confirm it isn't accidentally loosened while touching this area, per #267's own dev
  note; there's nothing new to build here.

## Track B — Sub-agent run visibility

### Problem

A Dispatch already writes a `sub_agent_marker` message into the parent thread, both on
dispatch and on completion (`recordSubAgentMarker` calls in `spawn-sub-agent.tool.ts:140` and
`sub-agent-notification.ts:61`). The UI has no rendering for it: `sub_agent_marker` is absent
from the `ThreadMessage` discriminated union (`ui/src/types/thread-message.ts`) and from the
rendering `switch` in `ui/src/components/thread-message.tsx:65-91`. The near-identical
`task_run_marker` already renders correctly and links to its Run thread, because its payload
carries `runThreadId` directly (`thread-message.ts:151`) — `sub_agent_marker`'s payload today
carries only `taskId`, `role`, `phase`, `outcome`, and `remainingCount`
(`thread-message-writer.ts:399-405`), nothing to link through.

### Change

Compose from the existing `task_run_marker` mechanism rather than building a parallel one:

- Add `runThreadId` to the **completion**-phase `sub_agent_marker` payload only
  (`recordSubAgentMarker`'s call site in `sub-agent-notification.ts`, where the completed
  Run's thread is already known). The **dispatch**-phase marker stays text-only ("Sub-agent
  dispatched — role: X, N others dispatched" where relevant) — at dispatch time the Run's
  thread hasn't been minted yet (per `api/AGENTS.md`'s "Automated task runs" section, a run's
  thread is minted on first start, not on enqueue), so there's nothing yet to link to. This
  matches the existing asymmetry for ordinary Tasks, which also get no marker at enqueue time,
  only at start/end.
- Add `sub_agent_marker` to the `ThreadMessage` union, and render it by composing/extending
  the existing `TaskRunMarkerMessage` presentational component — same card shape, same
  clickable-link behavior once a `runThreadId` is present — rather than a bespoke
  presentation, per this repo's Composition over Customization principle.
- "Monitoring" a Sub-Agent Task's Run means opening that link into the existing read-only
  `TaskRunView` (`ui/src/pages/chat/task-run-view.tsx`), unchanged. A Sub-Agent Task's Run
  already gets the same per-run `'task'`-type thread any Task Run gets (thread minting in
  `task-execution.ts` doesn't branch by `origin`); it only needs a working link into it. No
  new polling, streaming, or view is built.
- Sub-Agent Tasks never gain a card on the Task drawer/board. See ADR-0055 for why: they are
  structurally unable to reach a human (`ask_user`, `hand_off_task`, and `complete_task` are
  absent from a Sub-Agent Task's Run tool list by default — `getSubAgentToolIds()`,
  `tool-config.ts:218-225`), so board affordances like drag, pause, or hand-off don't apply to
  them.

### Non-goals

- No live, in-thread preview of a running sub-agent without navigating to its Run thread.
- No backfill of historical `sub_agent_marker` rows that predate the `runThreadId` field —
  they render as today (text-only, no link); only new markers carry it.

### Testing

Dev tests: `recordSubAgentMarker`'s new payload field (unit), the new `sub_agent_marker` case
in the rendering switch (Jest/Preact Testing Library). E2E: a Playwright scenario opening a
thread with a completed Sub-Agent Task's marker and confirming the link opens the expected
`TaskRunView`, per `e2e/AGENTS.md`'s guidance on mocking hard-to-reach states. Not an eval
concern — this is deterministic UI/plumbing, not LLM-facing behavior.

## Follow-ups (not in this change)

- Give the parent agent a way to pass gathered context (or a copy of part of the existing
  thread) into a Dispatch's `goal`, so "planning" can be reconsidered as a delegation case.
- Revisit whether the heuristic needs an explicit "don't also keep investigating inline after
  dispatching" instruction, if that pattern is observed in practice once this ships.
- File a new GitHub issue for Track B once this spec is committed, cross-referenced with #267.
