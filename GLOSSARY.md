# Dashboard Widgets

The dashboard widget system: file-backed cards of system/agent/user information, rendered on a per-user dashboard.

## Language

**Widget**:
One self-contained unit of dashboard content, persisted as its own file and discriminated by `type`. Each widget type defines its own payload on top of the fields every widget shares (`title`, `subtitle`, `order`).
_Avoid_: Card, tile, block

**Dashboard**:
A named collection of Widgets, stored as one subfolder on disk. Only a single `default` Dashboard exists today; multiple Dashboards are a planned extension (#316), not yet reachable from the UI.
_Avoid_: Board, page

**Widget Frontmatter**:
The YAML metadata block at the top of a widget's file: the fields every widget shares (`title`, `subtitle`, `type`, `order`), plus whatever scalar fields that widget's type needs (e.g. Big Number's `value`/`unit`, Line Graph's `color`, Pie Graph's `colors`).
_Avoid_: Metadata, header

**Widget Body**:
The widget file's content below the frontmatter delimiter. Its meaning is type-specific: Markdown's Body is free-text prose; Line Graph's and Pie Graph's Body is a CSV Body; Big Number has no Body at all.
_Avoid_: Content (ambiguous once more than one type exists)

**CSV Body**:
A Line Graph or Pie Graph widget's Body: plain two-column CSV text with a required `label,value` header row, parsed into `{labels, values}` at load time. No quoted-field escaping — a label containing a comma is a validation error, not an edge case to support.
_Avoid_: Data payload, series data

**Color Override**:
A widget's own `color` (Line Graph) or `colors` (Pie Graph) Widget Frontmatter field, replacing the default palette (`getDomainColor`) for that widget's rendering. Values must be hex strings (`#rgb` or `#rrggbb`); Pie Graph's `colors` apply positionally to its CSV Body's labels and cycle if shorter than the label count.
_Avoid_: Theme, palette override
