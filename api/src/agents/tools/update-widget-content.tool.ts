import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  updateWidgetContentHandler,
  type WidgetStoreDeps,
} from '../../routes/v1/dashboards.handlers.js';

const UpdateWidgetContentSchema = z.object({
  dashboardId: z
    .string()
    .optional()
    .describe("The dashboard the widget belongs to. Defaults to 'default' — the only dashboard that exists today."),
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
export function makeUpdateWidgetContentTool(deps?: {
  dashboardRoot?: string;
  store?: WidgetStoreDeps;
}) {
  return tool(
    async ({ dashboardId, widgetId, content }) => {
      const result = await updateWidgetContentHandler(
        deps?.dashboardRoot ?? env.dashboardRoot,
        dashboardId ?? 'default',
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
