# Splice-style Reorder via a dedicated atomic endpoint, not a 2-widget swap

#179's issue text describes drag as a 2-item swap, but we chose standard drag-reorder (list-splice) semantics instead: dropping widget A onto widget B moves A to B's slot and shifts everything between the old and new position by one. A splice can touch every widget on the dashboard in one drop, not just two, so it can't be expressed as (or made atomic via) the existing single-widget `PATCH /api/v1/dashboards/:dashboardId/widgets/:id` route called repeatedly. We add a dedicated `PATCH /api/v1/dashboards/:dashboardId/widgets/:id/reorder` (`{ targetWidgetId }`) that recomputes contiguous `order` values for the whole affected range and writes every changed widget file as one atomic operation (all or none) — and broadcasts a single `dashboard_reordered` event carrying every changed widget's new `order`, rather than firing the existing `widget_updated` event once per affected widget.

No optimistic locking: last write wins on a concurrent Reorder, same as every other widget write today — this is a single-user personal dashboard, not a multi-editor document.

## Considered Options

- A literal 2-widget swap (what #179 describes) — rejected: real drag-reorder UX, not what #314 wants; would have let the single-widget `PATCH` cover it with no new endpoint.
- Reuse the single-widget `PATCH` route, called once per affected widget — rejected: no atomicity across N file writes, so a crash mid-reorder leaves duplicate/inconsistent `order` values; also means N `widget_updated` broadcasts for what is, from the user's perspective, one action.
