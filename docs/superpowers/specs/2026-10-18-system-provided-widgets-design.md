# System-Provided Dashboard Widgets — Design

Status: Ready for implementation planning
Issue: [#320](https://github.com/tkottke90/amazing-hashbrown/issues/320) (parent: [#176](https://github.com/tkottke90/amazing-hashbrown/issues/176), prerequisite: [#315](https://github.com/tkottke90/amazing-hashbrown/issues/315))
Domain model: `GLOSSARY.md` (System Widget, Metric, Metric Registry), `docs/adr/0011`–`0013`

## 1. Problem

#315 shipped an agent/CLI write API for dashboard widgets and, while building it, reserved `source: 'system'` on `WidgetBase` (ADR-0003) as a placeholder for "application-collected metrics nobody asked for" — but built no producer for it. #320 is the open question of what that producer actually is. This spec resolves #320's five open questions and scopes the first implementation.

## 2. Architecture

A System Widget is not a variant of the existing write-based Widget — it is read-only by construction. See `GLOSSARY.md` for the canonical definitions of **System Widget**, **Metric**, and **Metric Registry**, and ADR-0011 for why this diverges from #315's write path rather than reusing it.

In short:

- A System Widget's file still lives in the dashboard folder and still has Widget Metadata (`title`, `subtitle`, `order`, `w`, `h`) — it participates in the grid exactly like any other widget.
- Its frontmatter carries a `metric` id instead of a Widget Payload. No value, body, or CSV Body is ever written to or read from that file.
- The dashboard read handler resolves `metric` against the Metric Registry on every GET and returns the live result alongside the file's metadata. Nothing is cached or persisted between requests for v1 (see §6, non-goals).
- The raw-edit endpoint and the agent/CLI content-write endpoint (#315) both reject any write targeting a `source: 'system'` widget's payload — there is nothing writable about it.
- Per ADR-0012, a System Widget never has a `maintainer` — there is no separate producer to name; the application itself is the only actor.
- Per ADR-0013, a System Widget is created the same way as any other widget: through the existing drawer. Choosing `source: system` swaps the type-specific form/raw editor for a Metric picker and a live preview of that Metric's current value. There is no auto-seeded, non-removable set of system widgets.

### Metric Registry shape

Each registered Metric declares:

- an `id` (stable string, stored in a widget's frontmatter)
- the widget `type`(s) it's valid for
- a resolver function, called in-process against the app's own stores (`WorkspaceStore`, `ObservabilityStore`, the `v_usage` view, etc.) — never an HTTP round-trip, mirroring how #315's agent tool calls handler functions directly rather than hitting the REST API over the loopback interface
- for a Pie/Line Graph–shaped Metric, the resolver returns the already-parsed `{labels, values}` shape directly — there's no CSV Body to produce or parse, since nothing is ever serialized to a file for a System Widget

The catalog of Metric ids is fixed in code, the same way the widget-type union is — not user-definable.

## 3. Metric catalog

Corrected from the original list: several "distribution" metrics fit the existing **Pie Graph** type (per #176's own worked example — "Agent Usage: Tool distribution") better than a Markdown list, so the type column below isn't limited to Big Number/Markdown as first discussed; it draws from all four existing widget types per Q12's "no new widget type" answer.

| #   | Metric                                     | Widget type      | Status       | Data source                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Current Version Info                       | Markdown         | **Wave 1**   | `package.json` name/version; `COMMIT_SHA`/`APP_VERSION` env (set by `Dockerfile`/`bin/docker-build.sh`, currently unread by app code — needs wiring); static GH repo link; release date + "newer version available" via opt-in GitHub Releases API call, falling back to a static "View Releases" link when disabled or on failure (Q11) |
| 7   | Total inference spending (USD)             | Big Number       | **Wave 1**   | `v_usage` view (`lib/observability/src/cost-store.ts`), `SUM(estimated_cost)`                                                                                                                                                                                                                                                            |
| 11  | Workspace Count                            | Big Number       | **Wave 1**   | `WorkspaceStore.listWorkspaces().length`                                                                                                                                                                                                                                                                                                 |
| 12  | Workspace List                             | Markdown         | **Wave 1**   | `WorkspaceStore.listWorkspaces()`, tagged Workspace/Project by presence of a `projects` row (Q10), linking to `/workspaces/:id`                                                                                                                                                                                                          |
| 13  | Project Count                              | Big Number       | **Wave 1**   | `WorkspaceStore.listProjects().length`                                                                                                                                                                                                                                                                                                   |
| 2   | Current Version Details (= #1 + changelog) | Markdown         | Follow-up    | same opt-in GitHub Releases call as #1, release notes body as changelog text                                                                                                                                                                                                                                                             |
| 3   | Usage by provider (tokens)                 | Pie Graph        | Follow-up    | `observability_traces`/`observability_spans`, grouped by provider — **not** "checkpoints" (Q3): a checkpoint is LangGraph thread state and carries no provider                                                                                                                                                                           |
| 4   | Usage by model (tokens)                    | Pie Graph        | Follow-up    | same tables, grouped by model+provider                                                                                                                                                                                                                                                                                                   |
| 5   | Usage by tool (count)                      | Pie Graph        | Follow-up    | `observability_spans` where `type = 'tool-call'`, grouped by tool name                                                                                                                                                                                                                                                                   |
| 10  | Failure rate by tool (count)               | Markdown (table) | Follow-up    | same spans, `WHERE error IS NOT NULL` vs. total, grouped by tool name                                                                                                                                                                                                                                                                    |
| 8   | Spend by provider (USD)                    | Pie Graph        | Follow-up    | `v_usage`, grouped by provider                                                                                                                                                                                                                                                                                                           |
| 9   | Spend by model (USD)                       | Pie Graph        | Follow-up    | `v_usage`, grouped by model+provider                                                                                                                                                                                                                                                                                                     |
| 14  | Queued Task Count                          | Big Number       | Follow-up    | `task_queue` rows where `status = 'pending'`                                                                                                                                                                                                                                                                                             |
| 15  | In Progress Tasks                          | Markdown         | Follow-up    | `task_queue` rows where `status = 'running'`, joined to `tasks`/`workspaces`; links go to `/workspaces/:id` only — there is no standalone task-detail URL today                                                                                                                                                                          |
| 6   | Skill usage (count)                        | —                | **Deferred** | nothing records a skill invocation today (`skill-expansion.middleware.ts` only expands `/command` text) — needs its own instrumentation issue before it can become a Metric                                                                                                                                                              |
| 16  | In-progress tasks by provider              | —                | **Deferred** | `Task.provider` is a creation-time pin, not a live "currently executing" field (Q13) — grouped alongside #6 as needing real instrumentation rather than a stand-in                                                                                                                                                                       |

## 4. Scope for this implementation

**Wave 1** (this issue): the Metric Registry mechanism plus #1, #7, #11, #12, #13 — one Big Number, one USD Big Number, one Markdown list with links and a type tag, and one Markdown widget exercising the opt-in-external-call-with-fallback pattern. No Pie/Line Graph Metric ships in wave 1; the follow-up issues below are where that path gets exercised for the first time and should budget for it.

**Follow-up issues** (filed separately, not part of this implementation):

- `{#3, #4}` — usage by provider/model (tokens), same tables, first Pie Graph Metrics
- `{#5, #10}` — tool usage + failure rate, same tables
- `{#8, #9}` — spend by provider/model (USD)
- `{#2}` — version details/changelog
- `{#14, #15}` — queued + in-progress tasks

**Deferred bucket** (blocked on new instrumentation, own issues, not scoped here): `#6` skill usage, `#16` in-progress tasks by provider.

## 5. Non-goals for this implementation

- **Live auto-refresh.** Unlike Agent/Manual writes, a System Widget's value never changes via a write event, so there's nothing for the existing SSE channel to broadcast. A System Widget's displayed value is as of the last dashboard load; polling or any other live-refresh mechanism is out of scope here and can be added later without any breaking change to the Metric Registry shape.
- **Caching.** Each Metric resolver runs its query fresh on every GET. If a specific Metric's query proves expensive, add caching to that resolver when it's proven necessary — not speculatively now.
- **A generalized "metrics table."** The data each Metric needs already exists in `WorkspaceStore`, `ObservabilityStore`, or the `v_usage` view; a resolver composes those, it doesn't introduce a new aggregation table. If a specific follow-up Metric genuinely can't be answered cheaply from existing tables/views, that's a call to make on that issue, not a blanket mechanism built here.

## 6. Terminology

See `GLOSSARY.md` for System Widget, Metric, and Metric Registry, and the pre-existing Widget/Widget Source/Widget Maintainer/Widget Payload/Widget Metadata entries this design builds on. See ADR-0011 (read-only, live-computed, never persisted), ADR-0012 (no maintainer), and ADR-0013 (added via the existing drawer, not auto-seeded) for why.
