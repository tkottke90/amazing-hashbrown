# Tool Usage & Failure-Rate Dashboard Widgets — Design

Status: Ready for implementation
Issue: [#327](https://github.com/tkottke90/amazing-hashbrown/issues/327) (parent: [#320](https://github.com/tkottke90/amazing-hashbrown/issues/320), grandparent: [#176](https://github.com/tkottke90/amazing-hashbrown/issues/176))
Domain model: `GLOSSARY.md` (System Widget, Metric, Metric Registry, Value Format, Compact Number Format, Failure Rate); ADR-0069, ADR-0070, ADR-0075, ADR-0059 (metric value format)

## 1. Problem

#320's Metric catalog (`docs/superpowers/specs/2026-10-18-system-provided-widgets-design.md`, rows #5 and #10) scoped two tool-call Metrics as follow-up work: tool-call usage distribution (Pie Graph), and failure rate by tool (Markdown table — a failure rate compares two independent counts per tool, not a single whole's proportions, so Pie Graph doesn't fit it the way it fits usage distribution). `ObservabilityStore` already tracks `tool_call_count`, but only per trace; no aggregate grouped by tool name across the whole table exists yet. This issue adds that aggregate and the two Metrics built from it.

## 2. The new store method

`ObservabilityStore.queryToolCallStats()` (`lib/observability/src/store.ts`):

```sql
SELECT name, COUNT(*) AS total, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed
FROM observability_spans
WHERE type = 'tool-call'
GROUP BY name
```

Returned as `{ name, total, failed }[]`. No `{ from, to }` range params — all-time only, unlike `CostStore.queryUsage()` — since nothing needs a narrower range yet (#320 §5's non-goal on speculative mechanism). `name` is non-nullable on `tool-call` spans, so grouping needs no null handling.

Both new Metrics call this one method and shape its result independently — mirroring how `CostStore.queryUsage()` already feeds both token-usage Metrics (`docs/superpowers/specs/2026-10-21-token-usage-widgets-design.md` §2) — rather than a shared "tool stats" module on top of it.

`ObservabilityStore` is wired into `MetricDeps` (`api/src/services/metric.ts`) via the existing `getObservabilityStore()` singleton, in `buildDefaultMetricDeps()` (`api/src/routes/v1/metrics.handlers.ts`) and wherever `dashboards.handlers.ts` resolves System Widgets.

## 3. The two Metrics

One file per Metric, following the existing one-file-per-metric convention (`api/src/services/metrics/*.metric.ts`):

| id                     | label             | displayType | sort                                                 | row inclusion                        | cap    |
| ---------------------- | ----------------- | ----------- | ---------------------------------------------------- | ------------------------------------ | ------ |
| `usage-by-tool`        | Tool Usage        | pie-graph   | descending by call count                             | one row per distinct tool name       | no cap |
| `failure-rate-by-tool` | Tool Failure Rate | markdown    | descending by failure rate, ties by total calls desc | every tool with ≥1 call, 0% included | no cap |

**`usage-by-tool`**: groups `queryToolCallStats()` rows by `name`, slice label is the tool name, slice value is `total`. Returns `{ displayType: 'pie-graph', labels, values, valueFormat: 'compact' }` — Compact Number Format applied the same way `usage-by-provider-tokens`/`usage-by-model-tokens` already apply it, since a busy tool's call count can get large too. Zero tool-call spans → `{ labels: [], values: [] }`, matching `usage-by-provider-tokens`'s empty shape.

No cap on distinct tools, same reasoning `usage-by-provider-tokens` already used for providers: tools are a code-registered catalog, not open-ended cardinality; if that changes, it's a follow-up.

**`failure-rate-by-tool`**: groups the same rows by `name`, computes `failed / total` per tool, renders a GFM table:

```
| Tool | Calls | Failures | Failure Rate |
| ---- | ----- | -------- | ------------ |
| ...  | ...   | ...      | ...%         |
```

Failure Rate is `Math.round((failed / total) * 100)` as a whole-number percent string, same rounding `task-non-completion-rate.metric.ts` already uses. Every tool with at least one call gets a row, including tools with zero failures (shown as `0%`) — this is an inventory of tool reliability, not just a list of tools that have ever failed. Zero tool-call spans → `_No tool calls recorded yet._`, matching `workspace-list.metric.ts`'s empty-state pattern.

"Failed" means `span.error IS NOT NULL` — see `GLOSSARY.md`'s **Failure Rate** entry, and ADR-0069/ADR-0070 (deriving failure from `span.error` rather than a semantic taxonomy, decided for the structurally identical Failure Breakdown feature) and ADR-0075 (why this doesn't double-count HITL-interrupted calls as failures).

## 4. UI rendering

No UI work needed. `displayType: 'markdown'` already renders through `react-markdown` + `remark-gfm` (`ui/src/components/markdown.tsx`), which renders GFM tables natively — the Metric just returns a `content` string with table syntax. `pie-graph` rendering at all three call sites (`PieGraphWidget`, `SystemWidgetValue`, the Metric picker's live preview) already shipped with #326 (`docs/superpowers/specs/2026-10-21-token-usage-widgets-design.md` §3).

## 5. Terminology

See `GLOSSARY.md`'s System Widgets section for **Failure Rate**, added by this issue and scoped narrowly to this Metric's own computation — not a general error-rate concept. No new glossary term for "tool name": it's `span.name` on a `tool-call` span, already named in #320's own catalog table, not worth its own entry.

No new ADR: the one genuine trade-off here (derive failure from `span.error` rather than a dedicated classification) was already decided and recorded by ADR-0069/ADR-0070 for the near-identical Failure Breakdown feature; everything else in this design (sort order, no cap, column layout) is cheap to reverse and unsurprising.

## 6. Testing

New code gets new tests, same as any Metric or store method:

- `ObservabilityStore.queryToolCallStats()` — unit test(s) in `lib/observability/src/store.test.ts`, covering grouping by name, the total/failed counts, and the zero-rows case.
- `usage-by-tool.metric.ts` / `failure-rate-by-tool.metric.ts` — unit tests against a stubbed `observabilityStore`, each covering its sort order, its row inclusion/empty-state behavior, and (for `failure-rate-by-tool`) the rounding.

## 7. Non-goals

Carried over from #320 §5 and still true here: no live auto-refresh, no caching, no generalized metrics table, no time-range filtering on these two Metrics (see §2). Nothing in this issue changes any of those.
