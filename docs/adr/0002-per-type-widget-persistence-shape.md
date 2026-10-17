# Per-type widget persistence shape: frontmatter scalars vs. CSV body

Big Number's `value`/`unit` are plain Widget Frontmatter scalars with no Widget Body; Line Graph's and Pie Graph's series data lives in the Widget Body as a CSV Body (header row `label,value`), not as JSON or as nested YAML arrays in frontmatter. We chose this per-type split, and CSV over JSON for the array data, because it keeps frontmatter YAML flat and keeps every widget's Body meaning consistent with the "Body is this widget's substantive, Raw-tab-editable, human- and agent-writable content" idea Markdown already established — a future reader shouldn't assume one uniform persistence shape applies to every widget type just because one happens to exist.

## Considered Options

- Nested YAML arrays in frontmatter for Line/Pie (`data: {labels: [...], values: [...]}`) — rejected: works, but means two of the four widget types have an empty Body while two don't for no visible reason, and it's a second, YAML-shaped data format alongside the CSV one introduced for the same conceptual payload.
- JSON text in the Body (what the design mockup prototyped for its own textarea editor) — rejected: no simpler to parse/validate than CSV for this shape, and less natural to hand-edit directly in the Raw tab's CodeMirror editor than two plain CSV columns.
