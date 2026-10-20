# Agent/CLI Dashboard & Widget Targeting — Design

**Date:** 2026-10-20
**Status:** Draft
**Related:** [Issue #339](https://github.com/tkottke90/amazing-hashbrown/issues/339) (this issue), [Issue #316](https://github.com/tkottke90/amazing-hashbrown/issues/316) / `docs/superpowers/specs/2026-10-19-multi-dashboard-management-design.md` (multi-dashboard management this splits out of, D15). Terminology used throughout (**Dashboard**, **Dashboard Id**, **Dashboard Name**, **Widget**, **Widget Payload**, **Widget Source**, **Dashboard Widget Target Snippet**) is defined in [`GLOSSARY.md`](../../../GLOSSARY.md). [ADR-0016](../../adr/0016-dashboard-id-permanent-decoupled-from-name.md), [ADR-0017](../../adr/0017-migrated-default-dashboard-keeps-its-id.md), and [ADR-0019](../../adr/0019-agent-dashboard-targeting-is-paste-only.md) record the decisions below that are hard to reverse.

---

## Goal

Let a user tell an agent (chat or CLI-driven automation) exactly which Dashboard and Widget to write to, now that `'default'` is no longer the only Dashboard — without teaching the agent to discover Dashboards/Widgets on its own.

## Problem

`api/src/agents/tools/update-widget-content.tool.ts` defaults an omitted `dashboardId` to the literal string `'default'`. That was fine when `'default'` was the only Dashboard; #316 made Dashboards plural, user-created, and identified by opaque `randomUUID()` ids a human has no way to read off the UI today. There is no agent-facing way to list Dashboards or Widgets, and no UI affordance for a user to hand an agent a specific Dashboard/Widget's ids.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | No `list_dashboards`/`list_widgets` agent tool is added. Targeting is paste-only: a user copies a Dashboard Widget Target Snippet from the widget itself and pastes it into chat.                                           | [ADR-0019](../../adr/0019-agent-dashboard-targeting-is-paste-only.md).                                                                                                                                                                  |
| D2  | `update_dashboard_widget_content`'s `dashboardId` still resolves without being supplied — but only when exactly one Dashboard exists, resolving to that Dashboard's actual id (not the hardcoded literal `'default'`). Once a second Dashboard exists, omitting `dashboardId` is a validation error.                               | Keeps today's "just omit it" convenience for the common single-Dashboard case, including the edge case where a user has renamed/deleted the original `default` Dashboard so the sole remaining Dashboard isn't literally called `default`. Forces explicitness the moment there's real ambiguity to resolve, which D1 rules out resolving any other way. |
| D3  | The validation error from D2 names the problem and points at the recovery path: copy the target Widget's Dashboard Widget Target Snippet and paste it, or pass `dashboardId` directly.                                      | D1 means the agent has no other way to find out; a bare "dashboardId is required" leaves it stuck with no actionable next step.                                                                                                      |
| D4  | A Dashboard Widget Target Snippet names: Dashboard Id, Dashboard Name, Widget Id, Widget Title, and Widget `type`. No payload-field-level targeting.                                                                        | Every writable widget `type` has at most two Widget Payload fields (`lib/amazing-hashbrown-widgets/src/types.ts`) — naming the type already tells the agent everything it could touch; a field selector would be new schema/UI surface for a problem that small. A Widget Id is only unique within its own Dashboard folder, so a snippet naming a Widget must always carry its Dashboard Id too. |
| D5  | The snippet is a single ready-to-paste natural-language sentence, not a structured block.                                                                                                                                    | Drops directly into a chat message and reads naturally; the agent parses it like any other instruction, with no new mini-format to define or maintain anywhere in the codebase.                                                        |
| D6  | The copy affordance is a per-widget button only — no separate Dashboard-only copy affordance.                                                                                                                                 | `update_dashboard_widget_content` never targets a Dashboard without also targeting a Widget, and no other agent tool exists that would need a bare Dashboard id. Nothing to copy it for yet.                                           |
| D7  | The button is omitted from System Widgets and Spacer Widgets.                                                                                                                                                                 | Neither has a Widget Payload an Agent/CLI write could ever touch — System Widgets' payload is resolved live and rejected outright by `updateWidgetContentHandler` (ADR-0011); Spacer Widgets have no payload at all. Offering a snippet for a target that can never be written to would be misleading. |

---

## Discovery (facts this design is built on)

- **Only one agent-facing dashboard tool exists today**: `update_dashboard_widget_content` (`api/src/agents/tools/update-widget-content.tool.ts`). No agent tool lists Dashboards or Widgets.
- **The store-layer functions this design needs already exist** (landed with #316): `listDashboards(root)` and `listWidgets(root, dashboardId)` in `lib/amazing-hashbrown-widgets/src/store.ts`, already exposed to the API layer via `WidgetStoreDeps` (`api/src/routes/v1/dashboards.handlers.ts`) — the tool's existing `deps?.store` injection point already carries `listDashboards`, so D2's resolution needs no new plumbing.
- **A Widget Id is per-Dashboard-folder, not global**: `createWidget` (`store.ts`) generates and collision-checks a Widget's id only within its own Dashboard's folder — confirming D4's "a Widget snippet must always carry its Dashboard Id."
- **Every writable widget type has ≤2 Widget Payload fields** (`types.ts`): Markdown (`content`), Big Number (`value`, `unit`), Line Graph (`data`, `color`), Pie Graph (`data`, `colors`) — confirming D4's "type-level is enough."
- **System Widgets already reject writes outright**: `updateWidgetContentHandler` returns a 400 ("…is a system widget and cannot be written to") for any widget with `type: 'system'` (ADR-0011) — confirming D7.
- **Spacer Widgets have no Widget Payload to write** and, per `types.ts`, no fields beyond the shared `WidgetBase` — confirming D7's other half.
- **The UI already holds everything a per-widget snippet needs, client-side**: `ui/src/hooks/use-dashboards.ts`'s module-level `dashboards` signal carries every Dashboard's id+name; each widget component (`markdown-widget.tsx`, `big-number-widget.tsx`, `line-graph-widget.tsx`, `pie-graph-widget.tsx`) already receives its own `widget` (id, title, type) and `dashboardId` props. No new API call or route is needed to build the snippet.
- **`WidgetAction` (`ui/src/pages/dashboard/widget-action.tsx`) is already a thin, type-agnostic shell** each writable widget type composes its own Edit/Delete buttons into — the repo's "Composition over Customization" principle (root `AGENTS.md`) points at adding one small, shared "copy target" button component here, composed the same way, rather than threading a new prop through `WidgetCard`/`WidgetRenderer`.
- **Clipboard-copy precedent already exists** (`navigator.clipboard.writeText`, e.g. `ui/src/pages/settings/notifications-panel.tsx`, `ui/src/components/chat-message.tsx`) with a transient icon-swap for copy confirmation, not a toast — the new button follows the same pattern.

---

## 1. API — `update_dashboard_widget_content` tool

`api/src/agents/tools/update-widget-content.tool.ts`'s schema is unchanged (`dashboardId` stays optional). The tool's callback changes:

- `dashboardId` supplied → used as-is (unchanged).
- `dashboardId` omitted → call `store.listDashboards(root)`:
  - Exactly one Dashboard exists → use its id (not the literal `'default'`).
  - Zero or more than one Dashboard exists → return an error message (D3): names the problem and tells the caller to either copy the target Widget's Dashboard Widget Target Snippet (D4/D5) and paste it, or supply `dashboardId` directly. No write is attempted.

This resolution step lives in the tool, not in `updateWidgetContentHandler` — the handler is shared with the real HTTP route, where `dashboardId` is always a concrete path segment and has no "omitted" case to resolve.

## 2. UI — the copy-target button

A new shared presentational component (e.g. `ui/src/pages/dashboard/widget-copy-target-button.tsx`), composed into `WidgetAction` by `markdown-widget.tsx`, `big-number-widget.tsx`, `line-graph-widget.tsx`, and `pie-graph-widget.tsx` only — not `system-widget.tsx` or `spacer-widget.tsx` (D7). Visible regardless of Edit Mode, matching the existing Edit/Delete buttons' own visibility in these four components.

On click: looks up the active Dashboard's name from `use-dashboards.ts`'s `dashboards` list by the `dashboardId` prop already passed to the widget, composes the Dashboard Widget Target Snippet sentence (D4/D5) from that name/id plus the widget's own `id`/`title`/`type` props, and copies it via `navigator.clipboard.writeText`, with the same transient icon-swap confirmation `notifications-panel.tsx`/`chat-message.tsx` already use.

---

## Out of scope (tracked elsewhere, or not tracked at all)

- `list_dashboards`/`list_widgets` agent tools — explicitly rejected, see ADR-0019.
- A Dashboard-only copy affordance (D6) and payload-field-level targeting (D4) — no current use case; revisit only if a future agent tool needs either.
