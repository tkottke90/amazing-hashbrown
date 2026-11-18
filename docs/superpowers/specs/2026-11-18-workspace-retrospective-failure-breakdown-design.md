# Workspace Retrospective Failure Breakdown — Design

**Date:** 2026-11-18
**Status:** Approved
**Issue:** [#401 — Workspace retrospective narrative evidence omits failure/tool detail, so the LLM invents a cause that fits the goal text](https://github.com/tkottke90/amazing-hashbrown/issues/401)

Domain terms used below (**Thread Report**, **Anomaly**, **Failure Breakdown**, **Tool-Call Distribution**) are defined in `GLOSSARY.md`'s "Workspace Retrospective Evidence" section. The two architectural decisions this design rests on are recorded as ADR-0069 and ADR-0070 and are not restated here.

---

## 1. Problem

`buildEvidenceSummary` (`api/src/agents/workspace-retrospective-narrative.ts:50-94`) is the entire evidence the workspace-retrospective narrative LLM receives. It only emits aggregate counts (`"Chat: 16 turns, 58 tool calls, 40 failures, 10 wiki writes"`) — no real error text, no tool-name detail — so the model has nothing concrete to reason from and, confirmed on the `gmail-labeler2` workspace retrospective, fabricates a cause that fits the workspace's stated goal text instead of the actual trace.

## 2. Failure Breakdown & Tool-Call Distribution (`lib/thread-reports`)

Per ADR-0069 and ADR-0070, `ThreadReportStats` (`lib/thread-reports/src/types.ts`) gains three new required fields, computed once per `buildThreadReport()` call from the same `traces` array `build.ts` already walks to compute `failureCount`:

```typescript
export interface ThreadReportStats {
  turnCount: number;
  toolCallCount: number;
  mostPopularTool: string | null;
  failureCount: number;
  wikiWriteCount: number;
  // Tool-Call Distribution — full per-tool-name call counts. mostPopularTool
  // stays (existing consumers read it), now redundant with this map's own
  // max — not removed, to avoid an unrelated churn.
  toolCallCounts: Record<string, number>;
  // Failure Breakdown — see GLOSSARY.md. Keyed by tool name; only
  // 'tool-call'-type spans with a non-null error contribute. Always
  // present (an empty object when nothing failed), matching the existing
  // mostPopularTool: string | null convention of never being optional.
  toolFailureCounts: Record<string, { count: number; example: string }>;
  // Failure Breakdown's non-tool-call bucket: llm-call/attachment span
  // errors and turn-level (no-span) trace errors. 'context_length' is the
  // one literal-matched category (ADR-0070); everything else is 'other'.
  otherFailures: Partial<Record<'context_length' | 'other', { count: number; example: string }>>;
}
```

`otherFailures` uses `Partial` (keys present only when that category actually occurred) rather than `toolFailureCounts`'s open `Record<string, ...>` — there are only ever two possible keys, so an always-both-present shape would mean constructing meaningless `{ count: 0, example: '' }` placeholders. `toolFailureCounts` has no fixed key set, so an empty object is the natural "nothing failed" value.

Each `example` string is the **full, untruncated** error message (R5-Q1) — truncation is a rendering concern, applied separately by `buildEvidenceSummary` (§3) and never by `report.njk` (§4).

### 2.1 Computation

A new function in `build.ts`, alongside the existing `computeStats`/`computeContextWindowSnapshot`:

```typescript
function computeFailureBreakdown(traces: TraceWithSpans[]): {
  toolFailureCounts: Record<string, { count: number; example: string }>;
  otherFailures: Partial<Record<'context_length' | 'other', { count: number; example: string }>>;
}
```

For each trace:

- For every span with `type === 'tool-call'` and a non-null `error`: bucket by `span.name` into `toolFailureCounts`, incrementing `count` and keeping the **first** encountered `error` string as that tool's `example`.
- For every span with `type === 'llm-call'` or `'attachment'` and a non-null `error`: bucket into `otherFailures` — `context_length` if the message contains the literal substring from `ContextBudgetExceededError` (`api/src/agents/summary-boundary.ts:143-146`), else `other`.
- If the trace has **zero** span errors and `trace.error` is set (mirroring `build.ts`'s existing mutual-exclusivity rule for `failureCount`, so the Breakdown's total always sums to `stats.failureCount`): bucket `trace.error` the same way (context_length-matched or `other`) into `otherFailures`.

`toolCallCounts` is lifted directly out of `computeStats`'s existing internal `toolCounts` map (currently built and then discarded down to just `mostPopularTool`) rather than recomputed.

### 2.2 Rendering in `report.njk`

Two new sections added to the existing "Stats" area (`lib/thread-reports/templates/report.njk`, near the current `meta-grid`), rendered in full with **no cap** (R3-Q1 — this is a human-scrolled static page, not an LLM prompt budget):

- **Tool Calls**: every entry in `toolCallCounts`, each annotated with its `toolFailureCounts` count if present (`"fetch_url: 23 calls, 23 failed"`), sorted by call count descending.
- **Other Failures**: `otherFailures`' entries (`context_length`/`other`), each with its count and full example message.

Both sections render only when non-empty (`toolCallCount > 0` / `failureCount > 0` respectively) — same omit-when-empty rule as §3's narrative text.

## 3. `buildEvidenceSummary` (`api/src/agents/workspace-retrospective-narrative.ts`)

For both the chat thread's block and each task run's block, append (as indented sub-bullets, never packed onto the existing dense status line — R4-Q1):

- A **tool-call distribution** bullet list — top 8 tools by call count (by `toolCallCounts`), each shown with its failure ratio when `toolFailureCounts` has an entry for that tool (`"- fetch_url: 23/23 failed"` / `"- read_wiki_page: 12 calls"`), remaining tools rolled into one `"- (+N more tools)"` line. Omitted entirely when `toolCallCount === 0`.
- An **other failures** bullet list — each `otherFailures` entry as `"- context_length: 3 (e.g. \"<first 120 chars of example>...\")"`,  omitted entirely when `otherFailures` is empty.

The top-8 cap and "+N more" rollup apply **only** to this rendered text (R2-Q6); the underlying `ThreadReportStats` fields themselves are never truncated or capped. Each rendered example message is cut to its first ~120 characters (R2-Q3); the stored `example` field stays full-length (§2, R5-Q1).

`MAX_EVIDENCE_CHARS` (currently 20000) is unchanged — the cap stays on the whole joined evidence string, and the new sections are bounded locally (top-8 + 120-char examples) specifically so one busy thread can't crowd out other tasks' evidence inside that existing budget (R1-Q7).

### 3.1 `PROMPT_PREFIX` addition (R5-Q2)

One sentence added to the existing prefix, targeting the actual failure mode (not just thin evidence, but goal-text bias when evidence is thin):

> "The goal describes intent, not necessarily what the thread actually did — ground every claimed cause in the evidence below, never in the goal text alone."

## 4. Testing

- **`lib/thread-reports/test/unit/build.test.ts`**: `computeFailureBreakdown` cases — a tool-call span error (bucketed by tool name, first example kept on repeat), an llm-call span error, an attachment span error, a turn-level `trace.error` with no span errors (mirroring the existing mutual-exclusivity rule), a `ContextBudgetExceededError`-shaped message matched to `context_length`, an unmatched message falling to `other`, and a trace with both span errors and a `trace.error` (only the span errors count, consistent with existing `failureCount` behavior). Also: the sum of all `toolFailureCounts`/`otherFailures` counts across a fixture equals `stats.failureCount`.
- **`lib/thread-reports/test/unit/render.test.ts`**: extend existing fixtures with the three new required `ThreadReportStats` fields (breaking change — every existing fixture constructing `ThreadReportStats` must add them); new cases asserting the Tool Calls / Other Failures sections render, including the omit-when-empty case.
- **`api/src/agents/workspace-retrospective-narrative.test.ts`**: orchestration tests on `buildEvidenceSummary`'s new rendering — sub-bullet formatting, top-8 + rollup, ratio phrasing, 120-char truncation, omit-when-empty for both the chat block and a task-run block; a `PROMPT_PREFIX` test confirming the new sentence is present.
- **New eval suite `suites/workspace-retrospective-narrative.yaml`** (R4-Q2), following `workspace-summary.yaml`'s/`thread-titles.yaml`'s convention (`appliesHarnessSystemPrompt: false`, `input` = the exact prompt this code sends):
  - `suite.id: workspace-retrospective-narrative`, `purpose` citing issue #401 and this design.
  - Scenario `bug-401-grounds-cause-in-evidence-not-goal-text`: `type: llm-judge`, `input` built from a hand-written evidence block in the new format (a goal about an unrelated topic, e.g. Gmail labeling; a named tool failing on all its calls, e.g. an MCP tool at 10/10 failed with a real-shaped example message; wiki-research tool calls succeeding normally), rubric asserting the "Likely causes" section names the actually-failing tool/category and does not claim an unsupported activity that merely matches the goal text.
  - **Hand-off**: per this repo's EDD rule 5, I cannot run this myself (no network path to local model providers). Run with:
    ```sh
    npm run eval -- --suite workspace-retrospective-narrative --model ollama --judge-model ollama
    ```

## 5. Out of scope

- Any change to `Anomaly` detection, the `Anomaly` type, or `WorkspaceRetrospectiveSummary` (R1-Q5) — this issue is scoped to narrative/report evidence, not deterministic problem-flagging.
- Cross-run aggregation of a task's multiple runs into one rolled-up Failure Breakdown (R1-Q6) — each `ThreadReportData` (chat or a single run) gets its own, independent Breakdown.
- A real error-message tokenizer/taxonomy beyond the one literal `context_length` match (ADR-0070) — `other` is an accepted, intentional catch-all.
- Removing `mostPopularTool` now that `toolCallCounts` makes it derivable — kept as-is to avoid unrelated churn to existing consumers.

## 6. Files changed

| File | Change |
| --- | --- |
| `lib/thread-reports/src/types.ts` | Add `toolCallCounts`, `toolFailureCounts`, `otherFailures` to `ThreadReportStats` |
| `lib/thread-reports/src/build.ts` | New `computeFailureBreakdown(traces)`; lift `toolCallCounts` out of `computeStats`'s existing internal map; wire both into `buildThreadReport()`'s returned `stats` |
| `lib/thread-reports/templates/report.njk` | New uncapped "Tool Calls" / "Other Failures" sections in the Stats area |
| `lib/thread-reports/test/unit/build.test.ts` | New `computeFailureBreakdown` cases (§4) |
| `lib/thread-reports/test/unit/render.test.ts` | Update existing fixtures with new required fields; new rendering cases |
| `api/src/agents/workspace-retrospective-narrative.ts` | `buildEvidenceSummary`: tool-distribution + other-failures sub-bullets, top-8 cap, ratio phrasing, 120-char truncation; `PROMPT_PREFIX` addition |
| `api/src/agents/workspace-retrospective-narrative.test.ts` | New rendering/prompt cases (§4) |
| `suites/workspace-retrospective-narrative.yaml` (new) | `bug-401-grounds-cause-in-evidence-not-goal-text` eval scenario |
| `GLOSSARY.md`, `docs/adr/0069-*.md`, `docs/adr/0070-*.md` | Already committed (domain-modeling pass) |
