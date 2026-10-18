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
A widget's `w`/`h` Widget Metadata fields — its span in grid columns/rows. Clamped per widget `type` to `[type minimum, 12×8]`; each type's minimum is a fixed constant, not user-configurable. A widget file that predates these fields reads as its type's minimum, the same backward-compatible default pattern as Widget Source.
_Avoid_: Dimensions, bounds

**Edit Mode**:
A dashboard-wide toggle state that enables grid drag (Reorder) and resize-handle (Widget Size) interactions on widgets, and gates both Ghost Cell rendering and Spacer Widget visibility. Other dashboard interactions are disabled while it's active. Purely a client-side UI state — never itself persisted; every dashboard load starts with it off regardless of how the previous session left it.
_Avoid_: Edit state, drag mode

**Spacer Widget**:
A Widget type with no content of its own — pure grid-occupying whitespace a user places and reorders like any other Widget, giving manual control over layout gaps without absolute positioning. Invisible outside Edit Mode; in Edit Mode it renders as a labeled, draggable, resizable placeholder like any other widget, minus a title/subtitle/provenance footer.
_Avoid_: Whitespace widget, blank widget, filler

**Ghost Cell**:
A decorative, non-interactive overlay shown only in Edit Mode over grid cells no Widget currently occupies — a dashed, 50%-opacity visual aid for arranging Widgets and Spacer Widgets. Never a drop target itself; see ADR-0011 for how its occupancy is computed.
_Avoid_: Ghost card (collides with Widget Card, the shared widget shell component), empty cell

**Reorder**:
The drag operation that moves a dragged widget to the position of whichever widget it's dropped on; every widget between the dragged widget's old and new slot shifts by one position. Supersedes #179's own "swap" description — a drop never exchanges just two widgets' positions, it's a full splice.
_Avoid_: Swap, move

**Widget Source**:
Which of a widget's write surfaces produced its last write: `manual` (the UI drawer), `agent` (an agent's conversational tool call, or a CLI-driven automation script — both count as the same source), or the reserved `system` (application-collected metadata nobody asked for; no producer exists yet — tracked by #320). A widget whose file predates this field reads as `manual`. Set by the calling code only — never a field the request body or an agent's tool-call arguments can supply.
_Avoid_: Provenance, writer, author

**Widget Maintainer**:
An optional free-text label on an `agent`-sourced widget, naming the automation or person responsible for its ongoing updates (e.g. a script name). Settable only by an Agent/CLI write, never by the UI drawer; preserved across any later write that doesn't resupply it. `system`-sourced widgets never have one (see System Widget).
_Avoid_: Owner, author

### System Widgets

**System Widget**:
A widget with `source: 'system'` whose payload is never stored in its file and never written by a person, Agent, or CLI — the dashboard read handler resolves it live, every time, from the app's own data via a Metric. Its Widget Metadata (title, subtitle, position, size) is file-backed and editable like any widget; only its payload is live-only.
_Avoid_: Live widget, telemetry widget

**Metric**:
A named, fixed computation a System Widget can display — one query against the app's own data (e.g. `workspace-count`, `usage-by-provider-tokens`), registered in code rather than user-definable. Chosen from a fixed catalog when a System Widget is created; the widget's frontmatter stores only the chosen Metric's id, never its result.
_Avoid_: Stat, KPI, system metadata

**Metric Registry**:
The in-process lookup from a Metric's id to the function that computes its current value, called directly by the dashboard read handler against the app's own stores — never over HTTP, never from a widget's file.
_Avoid_: Metrics API, producer registry

# AfterAgent & Wiki Write Scope

The background pipeline that inspects each conversational turn for durable knowledge and files it into the wiki, and the rule set that decides which wiki domain(s) a given turn — chat or AfterAgent — may write to.

## Language

**Write Scope**:
The set of wiki domains a given turn may write to, resolved fresh on every write (by `resolveWikiWriteScope`) from the originating thread/workspace — never fixed once when an agent is built, since an unbound workspace's exclusions depend on other workspaces' bindings, which can change independently. One of three kinds: Locked Scope, Open Scope, Unresolved Scope.
_Avoid_: Permission, access level, write policy

**Locked Scope**:
A Write Scope restricted to exactly one domain: the originating workspace's Bound Wiki. The only domain ever offered to AfterAgent's extraction step, or accepted by a chat write tool, under this scope.
_Avoid_: Restricted scope, project scope

**Open Scope**:
A Write Scope covering every wiki domain not Bound to a *different* workspace — the default for a workspace (or global chat) with no Bound Wiki of its own. Deliberately broad by design, for throwaway/no-commitment workspaces and global contexts; it is not itself a topical-relevance filter.
_Avoid_: Unrestricted scope, default scope

**Unresolved Scope**:
A Write Scope returned when the originating thread or workspace can't be determined at all. Denies every write; the fail-closed case.
_Avoid_: Unknown scope, null scope

**Bound Wiki**:
The one wiki domain a workspace is tied to via its `wikiId`. Binding is what turns a workspace's Write Scope from Open to Locked; an unbound workspace has no Bound Wiki and stays in Open Scope.
_Avoid_: Linked wiki, assigned wiki, dedicated wiki

**Domain Fit Score**:
A 1–10 integer the `extract` step assigns to the one domain it already picked from the candidate list, rating how well the content actually matches that domain — independent of whether the content is worth saving at all (that's `classify`'s job). Only meaningful under Open Scope; under Locked Scope there is exactly one candidate, so nothing to score.
_Avoid_: Confidence score, relevance score, match score

**Write Band**:
A Domain Fit Score of 8–10. The content commits immediately, the same way every AfterAgent write does today.
_Avoid_: High confidence, auto-write

**Review Band**:
A Domain Fit Score of 5–7. The pipeline makes no registry writes of its own and instead creates a Placement Review Task to let a human decide.
_Avoid_: Medium confidence, needs review

**Drop Band**:
A Domain Fit Score of 1–4. Treated exactly like AfterAgent's other no-op cases (an unrecognized domain, an empty candidate list) — nothing is written, nothing is staged, no provenance is kept.
_Avoid_: Low confidence, discard

**Placement Review Task**:
A task AfterAgent creates for a Review Band item instead of writing it — self-contained (title, extracted body, tags, the tentatively-matched domain and its Domain Fit Score), `assignedTo: 'agent'`, no trigger. Its own run asks the user where the content should go (or whether to drop it) and performs the actual write itself, through the ordinary wiki write tools — AfterAgent's pipeline never touches the registry for a Review Band item itself.
_Avoid_: Review queue, triage task, staging item

**Disposition**:
The `identified` AfterAgent outcome's own record of what actually happened to the knowledge it found: `written` (landed in the Write Band) or `review` (handed to a Placement Review Task). Distinct from the outcome itself — `identified` always means "worth saving," Disposition says where it ended up.
_Avoid_: Result, status, action
