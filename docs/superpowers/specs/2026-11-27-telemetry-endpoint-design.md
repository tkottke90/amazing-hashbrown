# Telemetry Endpoint (Prometheus) — Design

Date: 2026-11-27
Status: Draft, awaiting review

## 1. Problem

The dashboard's provider/model usage widgets (`usage-by-model-tokens`, `usage-by-provider-tokens`, `total-inference-spend`, `usage-by-tool`, `failure-rate-by-tool`) show all-time totals only. There is no way to see how usage changes over time. We want Prometheus to scrape the app so those figures can be graphed and alerted on as time series.

## 2. Scope

In scope — counters exposed on a new **Telemetry Endpoint**:

| Metric                               | Labels                           | Source                                     |
| ------------------------------------ | -------------------------------- | ------------------------------------------ |
| `hashbrown_llm_tokens_total`         | `provider`, `model`, `direction` | `CostStore.queryUsage()`                   |
| `hashbrown_llm_cost_usd_total`       | `provider`, `model`              | `CostStore.queryUsage()` (`estimatedCost`) |
| `hashbrown_tool_calls_total`         | `tool`                           | `ObservabilityStore.queryToolCallStats()`  |
| `hashbrown_tool_call_failures_total` | `tool`                           | `ObservabilityStore.queryToolCallStats()`  |

`direction` is `input` or `output`. Failure rate is **not** exposed as a ratio; it is computed in PromQL (`rate(failures[5m]) / rate(calls[5m])`).

Out of scope:

- **Skill usage** — nothing persists skill invocations today, so there is no store to derive from. Tracked in [#451](https://github.com/tkottke90/amazing-hashbrown/issues/451).
- Request/turn counts and latency histograms (no per-call rows to derive from; would need in-process instrumentation).
- `@prometheus-io/client` default process/GC/event-loop metrics.
- Workspace/project counts and other dashboard Metrics.
- Auth on the endpoint (the API has none anywhere; see §4).
- Playwright E2E coverage for this endpoint (decided out of scope for this change).

## 3. Key decision: counters are derived at scrape time

Each scrape reads the already-persisted totals and sets the counter values from them, rather than incrementing in-process counters at the moment usage is recorded.

Why:

- **Restart-safe.** Values are cumulative sums from the database, so a restart does not reset the series to zero.
- **Backfills history.** The first scrape immediately reports all-time totals.
- **No hook in code we don't own.** `CostStore` is written by `finalizeTurn`/turn observability; instrumenting increments there would couple Telemetry to it.
- **Same numbers as the dashboard**, because it reads the same stores.

Consequences / assumptions:

- A counter must be monotonic. This holds only if usage rows and tool-call spans are never deleted. No pruning code exists in this repo (searched `lib/observability`, `api/src`); if rows are ever pruned, scraped counters will decrease and Prometheus will read that as a reset. This is acceptable but must be documented in the ADR.
- Each scrape does a full-table aggregation. `queryUsage` is bounded by date and the aggregates are small (daily rows per provider/model, one row per tool), so cost is negligible at this app's scale. If it ever isn't, cache for a few seconds rather than change the model.
- `Counter` has no "set" API. Each counter's synchronous `collect()` hook calls `reset()` and then `inc()` with the stored cumulative total, so the exposed value equals the stored total and never decreases while data is intact. Verified against `@prometheus-io/client` 0.16.1, including label escaping; being synchronous, overlapping scrapes cannot interleave the reset and the increments.
- Cost is a float (`estimatedCost`), which Prometheus counters accept.

## 4. Endpoint

- `GET /metrics`, at the app root. Not under `/api/v1`: that prefix is for versioned API routes, and `/api/v1/metrics` is already the dashboard widget Metric route. Root `/metrics` is also Prometheus's default scrape path, so no `metrics_path` override is needed.
- Response: `Content-Type` from the `@prometheus-io/client` registry (`text/plain; version=0.0.4; charset=utf-8`).
- **Disabled by default.** Controlled by `telemetry.enabled` (default `false`). When disabled the route returns 404 as if it did not exist. Rationale: the endpoint exposes provider/model names, token counts and spend, and the API has no auth. Defaulting off avoids leaking this by accident in the Docker image.
- No bearer token or other auth in this change. Revisit if the API grows auth elsewhere.
- Config follows the existing pattern (`UpdatesSchema` in `api/src/config/env.ts`): add a `TelemetrySchema` with `enabled: z.boolean().default(false)`, wire it as an optional section, expose via `env.telemetry`. Read per request (like `checkForUpdates`) so a settings change takes effect without a restart; confirm during implementation whether a settings-UI entry is wanted or whether config-file only is enough (default: config-file only).
- Uses its own `Registry`, not `@prometheus-io/client`'s global default, so nothing else can leak onto the endpoint.

## 5. Structure

```
api/src/services/telemetry/
  registry.ts              builds the Registry and registers the collectors
  llm-usage.collector.ts   token + cost counters (CostStore)
  tool-calls.collector.ts  tool call + failure counters (ObservabilityStore)
  (+ adjacent *.test.ts)
api/src/routes/telemetry.route.ts      thin route: GET /metrics (root, not v1)
api/src/routes/telemetry.handlers.ts   Express-agnostic scrape handler
```

- The scrape handler takes the stores and the `enabled` flag as typed arguments and returns a `HandlerResult` (`{ok:true,data:{contentType,body}}` or `{ok:false,status:404,...}`), per the `*.handlers.ts` convention in `api/AGENTS.md`. The route file stays thin, untested wiring.
- Each collector is a small unit that registers itself into the registry (composition over a configurable "metric catalog"); adding skill usage later (#451) means adding one more collector, not changing existing ones.
- Mounted in `app.ts` at the root, outside `/api`.
- Label values for `provider`/`model` come from stored rows (config-defined providers/models), and `tool` from span names (the registered tool catalog), so cardinality is bounded.

## 6. Documentation deliverables

- **`GLOSSARY.md`**: new entry **Telemetry Endpoint** — the `GET /metrics` Prometheus scrape endpoint and its counters. State explicitly that it is unrelated to System Widget **Metrics** (the dashboard Metric Registry). Reword the System Widget entry's `_Avoid_: Live widget, telemetry widget` (line ~91) so "telemetry" there cannot be confused with the new term.
- **ADR** (next free number in `docs/adr/`): "Telemetry counters are derived from stored data at scrape time." Records the alternatives (in-process counters incremented at write time) and the monotonicity assumption from §3, and notes that skill usage (#451) may become the first exception.
- **`docs/App-Docs/configuration.md`**: document `telemetry.enabled` and a minimal Prometheus `scrape_configs` example.

## 7. Testing

Per `api/AGENTS.md` / root `AGENTS.md`: Mocha + Chai, tests adjacent to source, no supertest, tagged names.

- **Collectors `[unit]`**: with stub stores, assert the exposed text for known rows — token totals per provider/model/direction, cost sums, tool call/failure counts; empty stores produce no series (not errors); a model/provider name containing odd characters is escaped correctly in label output; values equal stored totals across two consecutive scrapes (no double counting) and increase correctly when new rows appear.
- **Handler `[orchestration]`/`[unit]`**: disabled → 404 result and stores are not read; enabled → 200 with the registry's content type and the combined body.
- No Playwright E2E for this change (explicit decision).
- No tests for the route wiring or third-party `@prometheus-io/client` internals (testing blacklist).
- Not an LLM-facing change; no eval scenarios required.

## 8. Dependencies

- Add `@prometheus-io/client` (0.16.1) to `api/package.json`. This is the successor to `prom-client`, which npm now marks deprecated in its favour; it has the same `Registry`/`Counter` API. It resolves through the repo's private registry.

## 9. Open items to settle in the implementation plan (not design questions)

- Exact `# HELP` strings.
- Whether `telemetry.enabled` also needs a Settings UI toggle (default: no).
