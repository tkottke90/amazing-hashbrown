# Pie Chart Compact Token Legend — Design

**Date:** 2026-11-08
**Status:** Draft
**Related:** `GLOSSARY.md` → "Dashboard Widgets" → "System Widgets" (**Value Format**, **Compact Number Format**), [ADR-0059](../adr/0059-metric-value-format-declared-on-resolved-value.md)

---

## Goal

Make the numbers `PieChart` shows in its legend and hover tooltip human-readable for the two token-usage System Metrics, without changing behavior for `PieChart`'s other consumers.

---

## Problem

`PieChart` (`ui/src/pages/dashboard/pie-chart.tsx`) renders every value it's given as a raw, unformatted number — in the legend (line 139) and in the on-slice hover tooltip (line 153). For the "Token Usage by Model" and "Token Usage by Provider" System Metrics, resolved values run into the hundreds of millions (e.g. `178693706`), which is both hard to read and a legend text-overflow risk, as seen in the Edit-widget preview.

`PieChart` is a single shared component with three consumers: the Edit-widget drawer's live Metric preview (`widget-drawer.tsx`), the live dashboard System Widget (`system-widget.tsx`), and a manual, CSV-sourced Pie Graph widget (`pie-graph-widget.tsx`) whose values are arbitrary user data, not necessarily token counts. Any fix has to account for all three.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The abbreviation rule itself is Compact Number Format, as defined in `GLOSSARY.md` — no separate rule invented here.                                                                                                                                                                                                 | One canonical definition; a later feature that also wants `k`/`M`/`B` notation cites the same glossary term instead of a new one drifting from it.                                                                                                           |
| D2  | The exact value stays available two ways: the existing on-slice hover tooltip keeps showing the exact number (now comma-grouped for readability, still not abbreviated) alongside its percent; the legend row additionally gets a native `title` attribute with the exact comma-grouped number.                   | Compact Number Format trades precision for space by design — both mechanisms let a user recover the exact count without the legend losing its readability/overflow fix. The row's `title` makes it discoverable without first finding the right slice.      |
| D3  | The formatter is a shared utility, not logic written directly into `PieChart` or duplicated at a call site.                                                                                                                                                                                                          | AGENTS.md's "Composition over Customization" principle; nothing today reuses it besides `PieChart`, but a one-off inline implementation is exactly the kind of duplication that principle warns against once a second consumer shows up.                    |
| D4  | `PieChart` does not apply Compact Number Format unconditionally — it stays generic, and a caller opts a given render in.                                                                                                                                                                                             | `PieChart` is shared with the manual CSV-driven Pie Graph widget, whose values can be currency, percentages, or anything else a user typed in — those must not be silently reformatted just because `PieChart` learned a new trick.                          |
| D5  | The opt-in signal is Value Format (`GLOSSARY.md`), declared on the resolved Metric value itself, not hardcoded by metric id inside `widget-drawer.tsx` or `system-widget.tsx`.                                                                                                                                      | See ADR-0059 for the full reasoning and the rejected alternative.                                                                                                                                                                                               |
| D6  | Only `usage-by-model-tokens` and `usage-by-provider-tokens` set a Value Format of Compact Number Format today. The manual CSV-driven Pie Graph widget never sets one, so its values are unaffected by this change.                                                                                                  | Matches D4/D5 — opting in is a Metric's decision, and these are the two Metrics with the overflow problem.                                                                                                                                                     |
| D7  | Big Number widgets (Project Count, Total Inference Spend, Workspace Count) are explicitly out of scope, even though they have the same unabbreviated-number issue via `.toLocaleString()`.                                                                                                                          | Different rendering path, and Total Inference Spend is a dollar amount where `k`/`M` abbreviation conventions can differ from plain counts — worth its own deliberate design pass rather than bundling in here.                                               |

---

## Non-goals

- **Currency-aware compact formatting** for Total Inference Spend or any other dollar-denominated value (D7).
- **Applying Compact Number Format to Big Number widgets** generally (D7).
- **Reformatting the manual CSV-driven Pie Graph widget's values** unless a future Pie Graph widget author explicitly opts in (D4/D6) — not possible today since only a Metric can set a Value Format.
- **Addressing legend label (model name) truncation/overflow** — out of scope; this design only changes how the numeric value is rendered.

---

## Open implementation notes (not design decisions — flagged for the implementer)

- `PieChart` (`ui/src/pages/dashboard/pie-chart.tsx:119-156`) needs a new opt-in prop (e.g. a `formatValue`/compact flag) consumed at the legend (line 139) and tooltip (line 153) render points.
- `ResolvedMetricValue`'s `pie-graph` variant (`lib/amazing-hashbrown-widgets/src/internal/widget-field-schemas.ts`, `lib/amazing-hashbrown-widgets/src/types.ts`) needs the new optional Value Format field; it's a shared, Zod-validated type consumed by both `api/` and `ui/`.
- Both `usage-by-model-tokens.metric.ts` and `usage-by-provider-tokens.metric.ts` (`api/src/services/metrics/`) need to set it on `resolve()`.
- `widget-drawer.tsx:688-695` and `system-widget.tsx:55-60` both already have the resolved metric value in scope at their `PieChart` call sites (`metricPreview.value` / `widget.resolved`) — read the Value Format there and pass the opt-in prop through; no new data plumbing needed.
- Existing adjacent tests to extend, per AGENTS.md's testing requirements: `ui/test/pie-chart.test.tsx` (legend/tooltip formatting), `ui/test/widget-drawer.test.tsx`, likely `ui/test/system-widget.test.tsx`, and the two metric test files (`api/src/services/metrics/usage-by-model-tokens.metric.test.ts`, `usage-by-provider-tokens.metric.test.ts`) for the new field. The shared formatter utility itself needs its own unit tests covering the Compact Number Format boundary cases (tier thresholds, decimal-drop, rounding).
