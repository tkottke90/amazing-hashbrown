# Handoff Notes Kickoff Continuity — Design

**Date:** 2026-11-01
**Status:** Approved
**Issue:** [#368 — Self-written handoff files from a run that exhausted budget are never resumed by a later run](https://github.com/tkottke90/amazing-hashbrown/issues/368)
**Decisions:** No new ADR — this reuses two already-established patterns (the previous-run-summary inlining and its `read_task_run` nudge, both already in `buildRunKickoff`) without a new trade-off to record; see §7.
**Glossary:** [Task File, Task Goal, Previous Tasks, Task Notes, Task Outcome, Handoff Notes](../../../GLOSSARY.md#task-files)

---

## 1. Problem & Goal

`generateHandoffNotes()` already runs at the end of every terminal run (`finishTaskFile`, called from every terminal branch except pause) and writes a real `Handoff Notes` value to the Task File — "a note to whichever Run comes next, written fresh at the end of each Run specifically to carry forward what that next Run should know or follow up on" (GLOSSARY.md). Issue #368 traced a real run (gmail-labeler workspace, `test-heuristic-update.js` task) that exhausted its context budget, left exactly such a note describing a real bug and its fix, and had that note never read by any later run.

The reason: nothing ever surfaces `Handoff Notes` back into a later run. `buildRunKickoff()` — the one message that opens every new run and the _only_ continuity between a task's runs, since each run starts in a fresh thread — carries forward only the previous run's one-line `summary` (`task_queue.summary`) plus a `read_task_run` pointer to the full transcript. `generateTaskGoal()` only consumes _other_ tasks' Task Outcomes (Previous Tasks), never this task's own prior Handoff Notes. The `read_task_notes` tool that could fetch Handoff Notes on demand is bound into every Task-File-eligible run, but nothing prompts the agent to call it. The field is generated correctly and then falls into a void — for every outcome, not just a budget-exhausted one, since generation doesn't distinguish why the prior run ended.

**Goal:** a new run of a task whose Task File carries non-empty `Handoff Notes` from its immediately preceding run sees that note, framed as something to act on, directly in its kickoff message — the same place and pattern the previous-run summary already uses — closing the gap for every ending (`done`, `failed`, `handed_off`, budget-exceeded, cancelled) uniformly.

**Out of scope (decided via grilling):**

- Cross-task visibility. `Previous Tasks` keeps ADR-0038's existing scope exactly as-is — each sibling task's Task Outcome only, never its Goal or Handoff Notes. This fix only ever surfaces a task's own Handoff Notes, to its own next run.
- The Resume path (`buildRunKickoff`'s `input.resume === true` early return). A resume continues the same run's existing thread, which was never subject to this gap — Handoff Notes are only written by an already-_finished_ run, and a resumed run's thread already holds whatever that prior run knew.
- Any token-budget cap on the inlined text (contrast ADR-0046, which caps `Previous Tasks`/`Task Notes` — both unbounded _lists_). `Handoff Notes` is a single field that `generateHandoffNotes` is already prompted to keep short; it has the same unbounded-but-small shape as the previous-run `summary` already inlined uncapped.
- Any change to `generateTaskGoal` or the Task Goal field. Handoff Notes surfaces only through the kickoff message, not through Task Goal regeneration.

## 2. Approach

Add an optional `handoffNotes` field to `RunKickoffInput`, sourced from the Task File state already loaded at the top of a run (`loadTaskState()` in `task-execution.ts`, read before that same run overwrites `state.goal`/`state.previousTasks`/`state.notes` — `state.handoff` is untouched until `finishTaskFile` runs at the _end_ of the run, so it still holds the previous run's value at kickoff-build time). When present, `buildRunKickoff()` appends a new block — independent of whether a `previousRuns` entry exists, so a Task File write from a run whose `task_queue` row doesn't surface as a `PreviousRun` (filtered out by `previousRunsOf`'s `FINISHED_RUN`/`threadId` checks) still gets its Handoff Notes shown — framing the note as something to verify or act on, and pointing the agent at `read_task_notes` (already bound whenever Handoff Notes would be non-empty, since both are gated on the same `taskFileScope`/`taskFile` eligibility) as the escalation path, mirroring the existing `read_task_run` nudge for the previous-run summary.

## 3. Components

### 3.1 `api/src/agents/task-context.ts`

- `RunKickoffInput` (currently lines 82–98): add `handoffNotes?: string`.
- `buildRunKickoff()` (currently lines 138–224ish): after the existing `if (previous) { ... }` block and before the `if (input.siblingContext)` block, add:

  ```ts
  if (input.handoffNotes) {
    lines.push(
      '',
      'Handoff notes from the previous run — treat this as something you need to act on ' +
        'or verify, not just background:',
      `"${input.handoffNotes}"`,
      "If that doesn't tell you everything you need, call read_task_notes() for the full " +
        'Task File — goal, notes, and outcome across every run.',
    );
  }
  ```

  Exact copy to be tuned against the new eval scenarios (§5) during implementation, same as every other kickoff block's wording was.

### 3.2 `api/src/agents/task-execution.ts`

At the `buildRunKickoff({...})` call site (currently ~line 641), add `handoffNotes: taskFileScope?.state.handoff || undefined` — `undefined` (not `''`) when there's no Task File or no prior note, so `buildRunKickoff`'s `if (input.handoffNotes)` check stays a single falsy test.

### 3.3 No other files change

`read_task_notes` (`tools/read-task-notes.tool.ts`) is unchanged — it's already bound under the identical `taskFile`/`taskFileScope` gate this fix reads `handoffNotes` from (`chat-agent.ts`'s `...(taskFile ? [makeWriteTaskNoteTool(), makeReadTaskNotesTool(task.id)] : [])`), so the new nudge never points at a tool that isn't actually available. `generateHandoffNotes`, `finishTaskFile`, and the Task File schema are unchanged — this is purely a read-side fix.

## 4. UI

No UI changes. This is agent-prompt content only; nothing in `ui/` renders `buildRunKickoff`'s output directly.

## 5. Evaluation-Driven Development

LLM-facing behavior (per root `AGENTS.md`'s EDD rules) — a failing eval scenario is required before implementation. Extend the existing `suites/scheduled-task-runs.yaml` ("Repeated Task Runs — Previous-Run History") rather than adding a new suite: its `purpose` already describes kickoff-message continuity between runs of the same task as the thing under test, and this fix extends that same mechanism from two carried-forward signals (summary, `read_task_run`) to three. Update the suite's `purpose` text to mention `Handoff Notes` alongside the existing two.

New scenarios (continuing the existing `str-00N` id sequence, next free: `str-006`):

- A kickoff carrying non-empty, self-sufficient Handoff Notes (e.g. "the fix for the off-by-one in the advisory-count comparator still needs to be applied") — the agent acts on it directly without first calling `read_task_notes`, mirroring `str-002`'s "don't re-read when you already have enough" shape.
- A kickoff carrying Handoff Notes that reference detail not in the note itself (e.g. "see this run's notes for the exact file/line") — the agent calls `read_task_notes` before proceeding, mirroring `str-001`'s "escalate when the summary alone doesn't answer the question" shape.

## 6. Testing

- **`task-context.test.ts`** (extended, `[unit]`): `buildRunKickoff` includes the Handoff Notes block (with the `read_task_notes` nudge) when `input.handoffNotes` is non-empty; omits it entirely when absent/empty; includes it even when `previousRuns` is empty; omits it on the `resume: true` early-return path. Extend the existing "stays in sync with `scheduled-task-runs.yaml`" sync test (currently lines 464–539+) to cover the new scenarios' literal kickoff text too, same rationale as the existing sync check (a wording change must fail here until the suite is updated).
- **`task-execution.test.ts`** (extended, `[orchestration]`): the `buildRunKickoff` call receives `handoffNotes` sourced from the just-loaded Task File state, not from any other field; receives `undefined` when the task isn't Task-File-eligible or the loaded state's `handoff` is empty.
- **E2E**: out of scope — no UI change (§4), and the behavior itself is an eval concern (§5).

## 7. Why no ADR

Checked against the three criteria `GLOSSARY.md`'s domain-modeling convention uses for offering an ADR: this fix is cheap to reverse (a few lines in one function), unsurprising in context (it makes the Task File's own documented purpose for `Handoff Notes` — GLOSSARY.md — actually true, rather than introducing new behavior), and isn't the product of a genuine alternatives trade-off — it reuses the previous-run-summary block's existing inlining-plus-escalation-tool pattern verbatim rather than choosing between real alternatives. All three criteria fail, so no ADR is recorded.

## 8. Acceptance Criteria (from #368)

- A task run whose Task File carries non-empty `Handoff Notes` from its immediately preceding run sees that note in its kickoff message, framed as actionable. §3.1, §3.2
- This holds for every prior-run ending (`done`, `failed`, `handed_off`, budget-exceeded, cancelled) uniformly, with no special-casing by outcome. §1, §2
- The Resume path and tasks with no Task File are unaffected. §1, §3.2
- `Previous Tasks`' existing cross-task scope (ADR-0038) is unchanged — no task sees another task's Handoff Notes. §1
- A failing eval scenario exists and is later made to pass before this is considered done. §5
