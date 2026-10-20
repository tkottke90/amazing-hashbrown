# Agent/CLI dashboard and widget targeting is paste-only, with no discovery tool

Now that Dashboards are plural (ADR-0016/ADR-0017), an Agent or the CLI has no server-side way to learn a non-`default` Dashboard Id, or a Widget Id within it, except being told directly — there is deliberately no `list_dashboards`/`list_widgets` agent tool, and none is planned. The only channel is a human copying a Dashboard Widget Target Snippet (see `GLOSSARY.md`) from the widget itself and pasting it into chat. `update_dashboard_widget_content`'s `dashboardId` keeps resolving to the sole existing Dashboard when omitted and only one exists (unchanged, backward-compatible); once a second Dashboard exists, omitting it is a validation error whose message points back at the Target Snippet affordance, rather than silently guessing which Dashboard was meant.

## Considered Options

- Adding `list_dashboards`/`list_widgets` discovery tools, mirroring `list_tasks`'s locate-then-act pattern — rejected: lets an agent self-serve without the user supplying anything, but adds two new always-available tool-call surfaces and a name-resolution step (Dashboard Names aren't unique) for a single-user app where the human directing the agent already has the dashboard open in front of them.
- Silently resolving an omitted `dashboardId` to some "current"/"active" Dashboard once plural — rejected: "active Dashboard" is a `localStorage`-only, per-browser-tab UI concept (see the multi-dashboard design's D13); there is no server-side value to resolve to.
