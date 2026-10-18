# System-sourced widgets are computed live, never persisted to the widget file

#320 reserves `source: 'system'` for application-collected metrics, but #315's write path stores a widget's payload on disk, where the drawer, the agent tool, the CLI, or the raw-edit endpoint could all overwrite it — undermining the one guarantee a "System" badge is supposed to give: that the number came from the app itself, not from something editable. Instead, a `system`-sourced widget's frontmatter carries a `metric` id instead of a Widget Payload, and the dashboard read handler resolves that id's current value in-process from the app's own stores (a Metric Registry) on every read — never reading a value from the widget file, never accepting a write to one. Widget Metadata (title, subtitle, position, size) stays file-backed and editable like any widget; only the payload diverges.

## Considered Options

- Reuse #315's write path with a scheduled job writing the computed value into the file (the original plan) — rejected: the value would then live in the same editable file as every other source, so a user or a malformed raw-edit could silently corrupt a number that's supposed to be trustworthy precisely because nothing edits it.
