# Feature: token-budget cap on Previous Tasks and Task Notes fed into Task Goal / Handoff Notes generation

## Context

[Issue #361](https://github.com/tkottke90/amazing-hashbrown/issues/361) reports a production failure: a single run's Previous Tasks list held 210 entries (393KB) for a Task that had itself run only 6 times, and the issue's own framing attributes this to recursive JSON re-escaping across runs.

Research during grilling corrected that framing. Previous Tasks is workspace-wide by design (GLOSSARY.md) and is rebuilt fresh every run (ADR-0038) — Task Files are YAML, not JSON, so there is no stringify-on-stringify path. The real bug is simpler and still serious: nothing caps how many sibling one-liners `previousTasks` can hold, nothing caps how large any individual entry can be, and the same unbounded-growth shape exists for Task Notes (the one field the prior Task Files design explicitly left uncapped). Both fields are consumed by one-off `model.invoke()` calls (`generateTaskGoal`, `generateHandoffNotes`) that sit entirely outside the chat agent's context-window middleware, so there is no budget enforcement anywhere on this path today.

This spec adds that enforcement. See GLOSSARY.md for Previous Tasks, Task Notes, Task Goal, and Handoff Notes; ADR-0038 for why Previous Tasks is scoped and re-derived the way it is; ADR-0039 for the precedent this spec deliberately does _not_ follow; and ADR-0046 for the capping decision and its rejected alternatives. This spec implements ADR-0046 rather than re-arguing it, and was reached through a full grilling (design-interview) pass with the repo owner, with a parallel domain-modeling pass settling the ADR/glossary questions — every section below reflects an explicit answer, not an assumption.

## Existing system (facts gathered during research)

- `TaskState.previousTasks: string[]` (`api/src/services/task-file.ts:17`) is overwritten every run from `listWorkspaceTaskFiles(workspace.location, task.id)` (`task-file.ts:193-232`), one `"<taskId>: <outcome>"` line per other Task File in the workspace, sorted ascending by filename timestamp (oldest-first, newest-last) — no cap. Built and consumed at `task-execution.ts:466-470`, fed straight into `generateTaskGoal`.
- `generateTaskGoal` (`api/src/agents/task-file-generators.ts:32-75`) is **not** a one-time call — its own doc comment says it's "regenerated at the start of every run and overwritten in place" (`task-execution.ts:457-488`, inside the unconditional `if (taskFileEligible)` block). So an unbounded `previousTasks` hits this prompt on every single run, not just the task's first.
- `TaskState.notes: string[][]` (`task-file.ts:21`) grows by one new segment per genuinely-new run (`task-execution.ts:494-500`); individual note strings come from `write_task_note` (agent free text, `tools/write-task-note.tool.ts:34-38`) and `update_plan` (mechanical status lines, `tools/update-plan.tool.ts:88-97`). No existing cap on segment count or per-segment size.
- `generateHandoffNotes` (`task-file-generators.ts:93-100`) receives `input.state.notes.flat()` — every run's notes, fully flattened and fully inlined, every time it's called (end of every run, via `finishTaskFile`, `task-execution.ts:167-172`).
- `estimateTokens(text: string): number` (`api/lib/llm-common-types/src/tokens/index.ts:9-11`, `Math.ceil(text.length / 4)`) is a plain string-in/number-out function — already called directly on bare strings elsewhere (`observability-handler.ts:83,85`), not just via the message-array wrapper used in `chat-agent.ts`. No adaptation needed to reuse it here.
- `env.chat.contextWindow.maxTokens` (`api/src/config/env.ts:358`, default `32000`) is the one existing, already-configured context budget in this codebase. Nothing about `generateTaskGoal`/`generateHandoffNotes` reads it today.
- ADR-0039's manifest-with-reference pattern (`taskId`/`goal`/`createdAt`, "read the file via `shell_exec` if you need it") only works because the workspace-chat agent that consumes it has a `shell_exec` tool bound. Neither `generateTaskGoal` nor `generateHandoffNotes` binds any tool — a manifest here would point the model at detail it has no way to fetch.

## Design

### 1. Shared helper — `api/src/agents/history-cap.ts` (new)

```ts
export const DEFAULT_HISTORY_BUDGET_FRACTION = 0.25;

export function getHistoryTokenBudget(fraction: number = DEFAULT_HISTORY_BUDGET_FRACTION): number {
  return Math.floor(env.chat.contextWindow.maxTokens * fraction);
}

export function capHistoryForPrompt(
  items: string[],
  maxTokens: number,
): { kept: string[]; omittedCount: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const cost = estimateTokens(items[i]!);
    if (used + cost > maxTokens) break;
    kept.unshift(items[i]!);
    used += cost;
  }
  return { kept, omittedCount: items.length - kept.length };
}
```

`items` is always assumed newest-last (matches `listWorkspaceTaskFiles`'s existing sort and `notes`' append order), so the walk runs from the end backward and `kept` comes back in original chronological order. One function serves both fields and both granularities (§2, §3) — per ADR-0046, no separate fixed-count/fixed-length heuristic.

### 2. `generateTaskGoal` — capping `previousTasks`

At `task-file-generators.ts:38-48`, before building the "Other tasks already done" section:

```ts
const budget = getHistoryTokenBudget();
const { kept, omittedCount } = capHistoryForPrompt(input.previousTasks, budget);
const lines =
  omittedCount > 0 ? [`...and ${omittedCount} earlier tasks not shown.`, ...kept] : kept;
if (lines.length > 0) {
  sections.push(
    `Other tasks already done in this workspace:\n${lines.map((t) => `- ${t}`).join('\n')}`,
  );
}
```

No change to `task-execution.ts:466-470` — `state.previousTasks` keeps storing the full, uncapped list in the Task File (ADR-0046: consumption-time cap only). The cap applies solely to what's rendered into this one prompt.

### 3. `generateHandoffNotes` — capping `notes`

At `task-file-generators.ts:93-100`, `notes` is `string[][]` (one array per run), so each run-segment is first rendered as a single atomic unit before going through the same helper — this is what makes the cap operate at segment granularity rather than individual-note granularity (per the settled grilling answer: never partially truncate a kept run's notes):

```ts
const segments = input.state.notes.map(
  (segment, i) => `Run ${i + 1}:\n${segment.map((n) => `  - ${n}`).join('\n')}`,
);
const budget = getHistoryTokenBudget();
let { kept, omittedCount } = capHistoryForPrompt(segments, budget);

if (kept.length === 0 && segments.length > 0) {
  // Even the single most-recent run's segment alone doesn't fit — fall back to
  // trimming within that one segment (still newest-line-first) rather than
  // dropping it entirely.
  const lastSegment = input.state.notes[input.state.notes.length - 1]!;
  const lineResult = capHistoryForPrompt(lastSegment, budget);
  kept = [`Run ${segments.length}:\n${lineResult.kept.map((n) => `  - ${n}`).join('\n')}`];
  omittedCount = segments.length - 1;
}

if (omittedCount > 0 || kept.length > 0) {
  const header =
    omittedCount > 0 ? `...and ${omittedCount} earlier run(s) of notes not shown.\n\n` : '';
  sections.push(`Notes recorded across every run so far:\n${header}${kept.join('\n\n')}`);
}
```

`input.state.notes` itself is untouched (ADR-0046: full data stays on disk) — only the rendered prompt section is bounded.

### 4. Budget sizing

Both call sites use `getHistoryTokenBudget()` with its default 25% fraction of `env.chat.contextWindow.maxTokens` (≈8,000 tokens today) — one shared derivation, no new env var (ADR-0046). The fraction is a named exported constant, not a magic number, so a future caller with a different tradeoff can pass its own fraction without touching the default.

## Error handling

- `capHistoryForPrompt` never throws — worst case for a pathological single oversized item is `kept: []`, which both call sites already handle (§2 renders nothing; §3 falls through to the single-segment fallback).
- This fix does not add a total-prompt budget check across the rest of `generateTaskGoal`/`generateHandoffNotes`'s prompt (task title/description/outcome/plan). Those fields are user-authored and already small in practice; an end-to-end guard was explicitly scoped out during grilling.
- `generateTaskGoal`/`generateHandoffNotes` keep their existing degrade-to-empty-string behavior on model failure (established by the Task Files design) — this fix doesn't change that.

## Testing

- `history-cap.test.ts` (new): `capHistoryForPrompt` — empty input; everything fits (no omission); items dropped oldest-first until budget exceeded; a single item alone exceeding the budget (`kept: []`, correct `omittedCount`); boundary case where the next item's cost exactly equals remaining budget. `getHistoryTokenBudget` — default fraction derives from `env.chat.contextWindow.maxTokens`; a custom fraction overrides it.
- `task-file-generators.test.ts` (extended): `generateTaskGoal` — the "Other tasks already done" section reflects the capped, not raw, `previousTasks`, and includes the `"...and N earlier tasks not shown."` marker only when something was actually omitted. `generateHandoffNotes` — the notes section reflects capped segments; the single-oversized-segment fallback renders a partial last segment instead of nothing; no marker/no section when everything fits.

**Out of scope, explicitly not built here:** a total end-to-end prompt-budget check covering task title/description/outcome/plan (see Error handling); pruning the stored, on-disk `notes`/`previousTasks` data (this remains an unbounded-disk-growth gap, accepted during grilling as a separate, future concern); an EDD eval scenario (this is a deterministic input-side truncation mechanism, not a change to model-facing behavior, so ordinary unit/orchestration tests cover it per `AGENTS.md`).
