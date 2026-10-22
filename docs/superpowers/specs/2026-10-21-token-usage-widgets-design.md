# Token Usage by Provider/Model Dashboard Widgets — Design

Status: Ready for implementation
Issue: [#326](https://github.com/tkottke90/amazing-hashbrown/issues/326) (parent: [#320](https://github.com/tkottke90/amazing-hashbrown/issues/320), grandparent: [#176](https://github.com/tkottke90/amazing-hashbrown/issues/176))
Domain model: `GLOSSARY.md` (System Widget, Metric, Metric Registry, LLM Usage Token)

## 1. Problem

#320's Metric catalog (`docs/superpowers/specs/2026-10-18-system-provided-widgets-design.md`, rows #3 and #4) scoped "usage by provider (tokens)" and "usage by model (tokens)" as follow-up work, deliberately excluded from Wave 1 because they're the first Metrics to use the `pie-graph` `displayType` — a shape the Metric Registry's types already declare (`ResolvedMetricValue`) but nothing resolver-side or UI-side handles yet. This issue builds those two Metrics and the rendering path they need.

## 2. The two Metrics

Both read from `CostStore.queryUsage()` (the `v_usage` view) — the same `EPOCH_FLOOR` → today, all-time range `total-inference-spend` already uses (`api/src/services/metrics/total-inference-spend.metric.ts`). `v_usage` already sums `input_tokens`/`output_tokens` per date/provider/model from `observability_traces`/`observability_spans`, so neither Metric needs a new store method or a direct trace/span query — reusing the one source every other usage-facing surface in this app (`usage.route.ts`, `total-inference-spend`) already reads from.

| id                         | label                   | groups rows by      | pie-slice label        | row count                                    | sort                 |
| -------------------------- | ----------------------- | ------------------- | ---------------------- | -------------------------------------------- | -------------------- |
| `usage-by-provider-tokens` | Token Usage by Provider | `provider`          | `<provider>`           | one per distinct provider, no cap            | descending by tokens |
| `usage-by-model-tokens`    | Token Usage by Model    | `(model, provider)` | `<model> (<provider>)` | one per distinct model+provider pair, no cap | descending by tokens |

"Tokens" means `inputTokens + outputTokens` summed per group — the same definition `usage.route.ts`'s own totals reduce already uses. Each resolver:

1. Fetches `usageStore.queryUsage({ from: EPOCH_FLOOR, to: today })`.
2. Reduces the flat per-date rows into a `Map` keyed by the grouping above, summing tokens.
3. Sorts entries descending by token count.
4. Returns `{ displayType: 'pie-graph', labels, values }` — no CSV, no cost math, no new aggregation table (per #320 §5's non-goal).

No cap on distinct slices in v1 — providers are a short configured list, and capping "by model" with an "Other" bucket is speculative complexity for a cardinality problem that may never show up in practice. If it does, that's a follow-up.

Why `(model, provider)` and not `model` alone for the second Metric: the same model name could appear under two different configured providers, and the issue's own requirement ("each labeled with its provider") exists specifically to keep those distinguishable.

## 3. UI rendering

`pie-graph-widget.tsx` draws its pie via an inline `useEffect` + `d3-selection`/`d3-shape` against an `<svg>` ref, driven by `{labels, values}` it gets from parsing a widget's CSV body. That draw logic is extracted into a small shared presentational component — `labels`, `values`, and an optional `colors` override, no other props — composed by three call sites instead of one:

1. **`PieGraphWidget`** (unchanged behavior) — still parses its CSV body first, then hands the parsed arrays to the shared component.
2. **`SystemWidgetValue`**'s `pie-graph` case in `system-widget.tsx` — currently renders a dash placeholder for `pie-graph`/`line-graph` (the comment there names this issue and #328 explicitly). Hands `widget.resolved.labels`/`.values` straight to the shared component — no CSV involved, per ADR-0011's live-computed-never-persisted shape.
3. **The Metric picker's live preview** in `widget-drawer.tsx` — currently only switches on `big-number`/`markdown` for `metricPreview.value`. Gets the same `pie-graph` case added.

No legend, no hover tooltip, no per-slice value display — matches `PieGraphWidget`'s existing presentation exactly. Adding a legend to the pie chart type is a separate, UI-wide concern, not something to introduce only for System Widgets.

`line-graph` stays unhandled at all three sites — out of scope here, tracked under #328.

## 4. Terminology

See `GLOSSARY.md`'s `LLM Usage & Cost Tracking` section for **LLM Usage Token** — added by this issue to disambiguate LLM input/output token counts from the pre-existing **Access Token** entry (Provider Authentication's OIDC bearer credential), which happened to claim the word "token" first. Scoped to that one term only: `Trace`/`Span` remain undocumented in `GLOSSARY.md` despite heavy use in code — a fuller observability-domain glossary pass is a legitimate but separate effort, filed as a follow-up rather than done piecemeal here.

No ADR: nothing in this design is hard to reverse, surprising, or the result of a genuine rejected alternative — it's the direct extension of Wave 1's own Metric Registry pattern to a `displayType` that pattern already declared.

## 5. Testing

New code gets new tests, same as any Metric:

- `usage-by-provider-tokens.metric.ts` / `usage-by-model-tokens.metric.ts` — unit tests against a stubbed `usageStore`, covering grouping, the tokens-desc sort, and the empty-data case.
- The extracted pie-chart UI component — a unit test on its own, plus coverage at each of its three call sites for the newly-handled `pie-graph` case.

Backfill (in scope for this issue, per explicit decision — not deferred): the entire Metric Registry mechanism shipped in Wave 1 with no test coverage at all, which stands against AGENTS.md's non-negotiable testing rule regardless of what this issue adds on top. This issue closes that gap:

- Unit tests for the 5 pre-existing Metric files: `workspace-count`, `project-count`, `total-inference-spend`, `workspace-list`, `version-info`.
- An orchestration test for `metric-registry.ts` — registration/lookup, and `resolveSystemWidget`'s three branches (non-system passthrough, unknown metric id, resolver throws), asserted on the returned widget's `resolved` field, not on log output (see root `AGENTS.md`'s testing-log-messages anti-pattern).
- A handler test for `metrics.handlers.ts` (`listMetricsHandler`, `previewMetricHandler`), following the existing `*.handlers.ts` extraction pattern — no supertest, no in-process server.

`metrics.route.ts` itself stays untested, consistent with every other route file in `api/` — it's thin wiring, not logic.

## 6. Non-goals

Carried over from #320 §5 and still true here: no live auto-refresh, no caching, no generalized metrics table. Nothing in this issue changes any of those.
