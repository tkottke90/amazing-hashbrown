import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import * as widgetsLib from '@tkottke90/amazing-hashbrown-widgets';
import { env } from '../../config/env.js';
import {
  updateWidgetContentHandler,
  type WidgetStoreDeps,
} from '../../routes/v1/dashboards.handlers.js';

const UpdateWidgetContentSchema = z.object({
  dashboardId: z
    .string()
    .optional()
    .describe(
      'The dashboard the widget belongs to. If omitted and exactly one dashboard exists, that ' +
        'dashboard is used automatically. Once more than one dashboard exists, this is required — ' +
        "get it from the target widget's Dashboard Widget Target Snippet.",
    ),
  widgetId: z.string().describe("The target widget's id, as shown on the dashboard."),
  content: z
    .record(z.string(), z.unknown())
    .describe(
      "Only the fields you're changing, e.g. { value, unit } for a Big Number widget, " +
        '{ content } for a Markdown widget, { data, color } for a Line Graph widget, or ' +
        '{ data, colors } for a Pie Graph widget. Anything you omit keeps its current stored ' +
        "value — you never need to know or resupply the widget's title. Optionally also " +
        'include `maintainer`: a short label naming what is keeping this widget up to date ' +
        '(e.g. a script name), which is preserved across later updates that omit it.',
    ),
});

// Static, always-available tool (D8) — not gated behind a skill command.
// Calls the same route handler the agent/CLI content-merge route uses,
// directly in-process, the same way other agents/tools/*.tool.ts files call
// into *.handlers.ts functions rather than making an HTTP round-trip to
// this same server. `source` is hardcoded to 'agent' here, never read from
// the model's own arguments (ADR-0005) — this tool cannot create, delete,
// rename a widget, or change its type (D10). `dashboardRoot`/`store` are
// optionally injected (defaulting to the production root/store) so this
// tool is directly testable against a real temp-dir-backed store, matching
// makeCreateWorkspaceTool's injection pattern.
// An omitted dashboardId is resolved against the real dashboard list (D2,
// docs/superpowers/specs/2026-10-20-dashboard-widget-targeting-design.md)
// — not hardcoded to the literal 'default' — and is a validation error once
// more than one Dashboard exists (no discovery tool exists, ADR-0019).
export function makeUpdateWidgetContentTool(deps?: {
  dashboardRoot?: string;
  store?: WidgetStoreDeps;
}) {
  return tool(
    async ({ dashboardId, widgetId, content }) => {
      let resolvedDashboardId = dashboardId;

      if (!resolvedDashboardId) {
        const store = deps?.store ?? widgetsLib;
        const dashboards = await store.listDashboards(deps?.dashboardRoot ?? env.dashboardRoot);

        if (dashboards.length === 0) {
          return (
            'No dashboards exist yet, so dashboardId cannot be resolved automatically. ' +
            "Create a dashboard first, or ask the user to copy the target widget's Dashboard " +
            'Widget Target Snippet and paste it, or supply dashboardId directly.'
          );
        }
        if (dashboards.length > 1) {
          return (
            'dashboardId is required once more than one dashboard exists — it cannot be ' +
            "resolved automatically. Ask the user to copy the target widget's Dashboard " +
            'Widget Target Snippet and paste it, or supply dashboardId directly.'
          );
        }
        resolvedDashboardId = dashboards[0]!.id;
      }

      const result = await updateWidgetContentHandler(
        deps?.dashboardRoot ?? env.dashboardRoot,
        resolvedDashboardId,
        widgetId,
        content,
        'agent',
        deps?.store,
      );
      if (!result.ok) return `Widget not updated: ${result.error}`;
      return `Updated widget "${widgetId}".`;
    },
    {
      name: 'update_dashboard_widget_content',
      description:
        "Update an existing dashboard widget's content by its id. Cannot create, delete, or " +
        "rename a widget, or change its type — only a widget's own type-specific content.",
      schema: UpdateWidgetContentSchema,
    },
  );
}
