# Metric Value Format is declared on ResolvedMetricValue, not hardcoded per-id in UI components

A Metric can now set a Value Format (starting with Compact Number Format) on its own resolved value, rather than each widget-rendering component inferring formatting from a Metric's id. We chose this because `ResolvedMetricValue` is already the one validated contract every renderer reads at the exact point it displays a Metric's numbers, so a Metric-declared hint reaches every current and future renderer for free, with no per-consumer id check to keep in sync as new Metrics are added. The trade-off: adding a new Value Format means extending the shared `ResolvedMetricValue` schema rather than a UI-only change.

## Considered Options

- Hardcode per-id checks in each widget-rendering component (e.g. `metric.id === 'usage-by-model-tokens' || ...`) — rejected: duplicates the check in every renderer that cares, and silently stays stale when a new Metric needs the same treatment.

## Consequences

A manually-authored widget whose values aren't backed by a Metric (e.g. a CSV-sourced Pie Graph widget) never has a Value Format and is therefore never reformatted — only Metric-driven values can opt in, and only the Metric itself decides.
