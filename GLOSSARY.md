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

**Widget Payload**:
A widget's type-specific fields, excluding the shared `title`/`subtitle`/`order` — Markdown's Widget Body; Big Number's `value`/`unit`; Line Graph's and Pie Graph's CSV Body plus Color Override. The only part of a widget an Agent or the CLI may write.
_Avoid_: Content (see Widget Body's own avoid-note), data

**Widget Metadata**:
A widget's shared, type-independent fields: `title`, `subtitle`, `order`, `w`, `h` — a subset of its Widget Frontmatter that excludes `type` and any Widget Payload scalars. Editable only through the UI — the drawer's form fields for `title`/`subtitle`, direct grid drag-and-resize for `order`/`w`/`h` — never part of an Agent or CLI write.
_Avoid_: Frontmatter (broader — includes `type` and Widget Payload scalars too)

**Widget Size**:
A widget's `w`/`h` Widget Metadata fields — its span in grid columns/rows. Clamped per widget `type` to `[type minimum, 12×8]`; each type's minimum is a fixed constant, not user-configurable.
_Avoid_: Dimensions, bounds

**Edit Mode**:
A dashboard-wide toggle state that enables grid drag (Reorder) and resize-handle (Widget Size) interactions on widgets. Other dashboard interactions are disabled while it's active. Purely a client-side UI state — never itself persisted; every dashboard load starts with it off regardless of how the previous session left it.
_Avoid_: Edit state, drag mode

**Reorder**:
The drag operation that moves a dragged widget to the position of whichever widget it's dropped on; every widget between the dragged widget's old and new slot shifts by one position. Supersedes #179's own "swap" description — a drop never exchanges just two widgets' positions, it's a full splice.
_Avoid_: Swap, move

**Widget Source**:
Which of a widget's write surfaces produced its last write: `manual` (the UI drawer), `agent` (an agent's conversational tool call, or a CLI-driven automation script — both count as the same source), or the reserved `system` (application-collected metadata nobody asked for; no producer exists yet — tracked by #320). A widget whose file predates this field reads as `manual`. Set by the calling code only — never a field the request body or an agent's tool-call arguments can supply.
_Avoid_: Provenance, writer, author

**Widget Maintainer**:
An optional free-text label on an `agent`-sourced widget, naming the automation or person responsible for its ongoing updates (e.g. a script name). Settable only by an Agent/CLI write, never by the UI drawer; preserved across any later write that doesn't resupply it.
_Avoid_: Owner, author
