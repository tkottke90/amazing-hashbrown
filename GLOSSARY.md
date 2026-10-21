# Dashboard Widgets

The dashboard widget system: file-backed cards of system/agent/user information, rendered on a per-user dashboard.

## Language

**Widget**:
One self-contained unit of dashboard content, persisted as its own file and discriminated by `type`. Each widget type defines its own payload on top of the fields every widget shares (`title`, `subtitle`, `order`).
_Avoid_: Card, tile, block

**Dashboard**:
A named collection of Widgets, stored as one subfolder on disk. Users can create, switch between, rename, and delete Dashboards; each keeps its own Widgets and Dashboard Metadata independent of every other Dashboard.
_Avoid_: Board, page

**Dashboard Id**:
A Dashboard's permanent identifier, assigned once at creation and never changed — it names the Dashboard's on-disk subfolder and is unaffected by renaming. Generated via `randomUUID()` for new Dashboards; the original Dashboard keeps its pre-existing id, `default` (see ADR-0017).
_Avoid_: Slug, key, dashboard slug

**Dashboard Name**:
A Dashboard's mutable, user-facing display label, editable at any time. Not required to be unique — a Dashboard's identity is carried entirely by its Dashboard Id, never by Name.
_Avoid_: Title, label

**Dashboard Metadata**:
A Dashboard's own persisted file, holding its Name, Description, and Density — the per-Dashboard analogue of Widget Frontmatter, but describing the Dashboard itself rather than one of its Widgets. See ADR-0018.
_Avoid_: Dashboard config, dashboard settings (the UI panel that edits it, not the stored file)

**Density**:
A Dashboard Metadata field, `compact` or `roomy`, controlling that Dashboard's grid row height/spacing. Defaults to `compact`.
_Avoid_: Spacing, grid size

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

**Dashboard Widget Target Snippet**:
A ready-to-paste natural-language sentence, copied from a writable Widget's own copy-targeting button, naming that Widget's Dashboard Id, Dashboard Name, Widget Id, Widget Title, and type — everything an Agent or the CLI needs to resolve `update_dashboard_widget_content`'s `dashboardId`/`widgetId` without any other lookup. Not offered on System Widgets or Spacer Widgets, neither of which has a Widget Payload an Agent/CLI write could ever touch. See ADR-0019.
_Avoid_: Targeting snippet, copy snippet, targeting info

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
A Write Scope covering every wiki domain not Bound to a _different_ workspace — the default for a workspace (or global chat) with no Bound Wiki of its own. Deliberately broad by design, for throwaway/no-commitment workspaces and global contexts; it is not itself a topical-relevance filter.
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

# Skill Invocation & Runtime Access

How a running skill learns which skill is currently active, and reaches its own scripts and reference docs at runtime instead of only getting its body text injected once.

## Language

**Active Skill**:
The name of whichever skill a slash-command invocation most recently resolved to, tracked in agent state and persisted across subsequent non-slash-command turns until another slash command resolves. Set for every skill invocation, not only the ones with a Skill-Gated Tools registration — broadening what the field (formerly `activeGatedSkill`) tracks (see ADR-0019).
_Avoid_: Current skill, invoked skill, activeGatedSkill

**Skill-Gated Tools**:
The existing pattern (`skill-gated-tools.middleware.ts`) that hides a specific tool from the model's tool list unless the Active Skill is exactly the one named skill registered for it in `GATED_SKILL_REGISTRATIONS` — e.g. `create_workspace` only shows up while `create-workspace` is the Active Skill. One registration maps one skill to its own tool set.
_Avoid_: Gated tools (ambiguous with Skill-Scoped Tools)

**Skill-Scoped Tools**:
Tools visible whenever any skill is the Active Skill, rather than one specific registered skill — and that resolve "which skill" implicitly from the Active Skill at call time instead of taking a skill name as an argument. `read_skill_reference` and `run_skill_script` are Skill-Scoped Tools.
_Avoid_: Gated tools, active-skill tools

**Skill Artifact**:
A file belonging to a skill's `scripts/` or `references/` directory — its executable scripts and reference docs, collectively, as distinct from the skill's own `SKILL.md` body and frontmatter.
_Avoid_: Skill file, resource

**Artifact Index**:
A block of text computed fresh from disk and appended after a skill's authored body on every invocation, listing every Skill Artifact currently present and the exact `read_skill_reference`/`run_skill_script` call needed to use it. Never written back into `SKILL.md` — regenerated every time so it can't drift from what's actually on disk (see ADR-0022).
_Avoid_: Artifact manifest, script list

# Provider Authentication

How a configured LLM Provider authenticates its outbound requests, and the Azure OpenAI Provider's OIDC-specific credential lifecycle.

## Language

**Provider**:
One configured LLM backend (`providers[]` entry) — a `name`, a `type` that selects its client implementation (`ollama`, `openai`, `anthropic`, or Azure OpenAI Provider), and whatever connection/auth fields that `type` needs.
_Avoid_: Model provider, backend

**Azure OpenAI Provider**:
A Provider `type` authenticated only via OIDC/OAuth2 Client Credentials Flow rather than a static API key — the one Provider `type` this app supports OIDC for. Identified by an `endpoint`, a Deployment Name, and an `apiVersion` rather than a live model catalog.
_Avoid_: OIDC provider, Azure provider

**Deployment Name**:
An Azure OpenAI Provider's single selectable "model." Azure OpenAI is deployment-scoped rather than model-id-scoped, so this is shown as-is in place of a live model list, and doubles as the key for any per-model pricing/sampling override.
_Avoid_: Model, model id (for this Provider type)

**Client Credentials**:
The `tokenUrl`, `clientId`, `clientSecret`, `scope`, and `grantType` an Azure OpenAI Provider is registered with — distinct from the Access Token they're exchanged for.
_Avoid_: OIDC config, credentials (ambiguous with Access Token)

**Access Token**:
The short-lived bearer credential an Azure OpenAI Provider's Client Credentials are exchanged for. Held in memory only, keyed by Provider name, never written to disk; refreshed proactively before it would be handed out expired or near-expiry.
_Avoid_: Token, credential (see Client Credentials)

**Revoke**:
Clearing an Azure OpenAI Provider's cached Access Token without touching its stored Client Credentials, forcing re-authentication on the next use. Not a call to an IdP revocation endpoint — a client-credentials Access Token has no standard one.
_Avoid_: Logout, disconnect, Refresh

**Rotate**:
Replacing an Azure OpenAI Provider's `clientId`/`clientSecret` (its `tokenUrl`/`scope`/`grantType` stay as-is), validated by fetching a fresh Access Token with the new values before the change is persisted — a failed fetch rejects the whole write.
_Avoid_: Reset, Refresh (Refresh is the automatic proactive renewal of an already-registered Access Token; Rotate is the user-initiated replacement of the Client Credentials themselves)

**Custom Headers**:
An optional, per-Provider map of static HTTP headers sent with every one of that Provider's requests, merged on top of whatever its auth sets. Applies to every Provider type, not just the Azure OpenAI Provider.
_Avoid_: Default headers, request headers

# Thread Archiving & Sidebar Visibility

How a chat thread leaves the global chat sidebar — permanently via Archiving, or temporarily via inactivity — without the underlying data ever being deleted.

## Language

**Archived Thread**:
A chat thread with a non-null archive timestamp. Hidden from the sidebar regardless of age, and rejects chat, retry, hitl-answer, and fork with a 409 — renaming, deleting, generating a report, and Unarchiving stay allowed. Opening one never makes it the active thread (see ADR-0029).
_Avoid_: Closed thread, locked thread, frozen thread, stale thread (see Sidebar Retention Window, a different and unrelated state)

**Archive** / **Unarchive**:
The two actions that set and clear a thread's archive timestamp. Archive is reachable from both the sidebar's own thread row and the Threads page; Unarchive only from the Threads page, since an Archived Thread never appears in the sidebar to unarchive from.
_Avoid_: Close/Reopen, Lock/Unlock, Hide/Show (see Sidebar Retention Window)

**Sidebar Retention Window**:
The `chat.sidebarRetentionDays` config value: how many days since a chat thread's `updatedAt` before it's excluded from the sidebar's own thread list (see ADR-0027, ADR-0030). This is a live computation against `updatedAt`, not a persisted flag on the thread — unlike an Archived Thread, a thread this excludes carries no state of its own, stays fully usable, and reappears in the sidebar the moment it's continued and `updatedAt` moves forward again.
_Avoid_: Stale thread, hidden thread, archived (not to be confused with Archived Thread, a real persisted state this one deliberately isn't)

# Task Archiving & Done Lane Retention

How a Done or Cancelled task leaves the Workspace board's Done lane and the Inbox's default view — permanently via Archiving, or temporarily via inactivity — without the task or its history ever being deleted. The same split this app already uses for Thread Archiving & Sidebar Visibility, applied to tasks instead of chat threads.

## Language

**Archived Task**:
A task with a non-null archive timestamp. Hidden from the Done lane and the Inbox by default regardless of age; rejects reopen, rerun, and reschedule board-moves until Unarchived (see ADR-0032) — deleting it and editing its title/description/due date stay allowed. Shown with a distinguishing badge when revealed via the Show Archived toggle.
_Avoid_: Closed task, locked task, dismissed task, hidden task (see Aged-Out Task, a related but different state)

**Archive** / **Unarchive**:
The two actions that set and clear a task's archive timestamp, reachable from a Done-lane card's own menu, an Inbox row's own action, or the Task Drawer. Unarchive also bumps the task's `updatedAt` (see ADR-0034), unlike the equivalent thread actions.
_Avoid_: Close/Reopen, Dismiss/Restore, Hide/Show (see Aged-Out Task)

**Aged-Out Task**:
A task excluded from the Done lane and the Inbox's default view purely because the Done Lane Retention Window has passed since its `updatedAt`. Not a persisted state — carries no badge, stays fully interactive, and can be reopened or rerun directly without Unarchiving first (see ADR-0032). Reappears the moment anything bumps its `updatedAt`.
_Avoid_: Archived (see Archived Task, a different and persisted state), stale task

**Done Lane Retention Window**:
The single global `tasks.doneRetentionDays` config value: how many days since a task's `updatedAt` before a task currently in the Done lane becomes an Aged-Out Task. Applies identically to the Workspace board and the Inbox's default fetch; the Show Archived toggle always bypasses it. Defaults to `5` (see ADR-0031).
_Avoid_: Stale window, cleanup window

**Show Archived** (toggle):
The board/Inbox control that, toggled on, reveals both Archived Tasks and Aged-Out Tasks back into their normal view in one combined pass. Resets to off on every page load — never remembered across sessions, the same convention this app already uses for other page-level display toggles (e.g. Dashboard's Edit Mode).
_Avoid_: View all, archive filter, done filter

# Task Files

How a workspace-scoped Task keeps a durable, human- and agent-readable record of itself on disk, so a new Run doesn't have to rediscover what earlier Runs already learned.

## Language

**Task File**:
One markdown file per workspace-scoped Task, created on its first Run and updated in place across every later Run — the durable artifact letting a user or agent see what happened on a Task without reopening every past Run's own conversation. Never created for a workspace-less Task, and never created for a Sub-Agent Task.
_Avoid_: Task note file, task log, task artifact

**Task State**:
The five fields a Task File holds — Task Goal, Previous Tasks, Task Notes, Task Outcome, Handoff Notes — stored as the file's YAML frontmatter, its only durable copy. The markdown body beneath the frontmatter is a rendering of this same State, not a second copy with its own meaning.
_Avoid_: Frontmatter (too generic — doesn't say what it holds), task metadata

**Task Goal**:
A Task File's own restatement, in the task's own words, of what the Task is trying to do. Regenerated at the start of every Run from the Task's title/description/outcome/plan and its Previous Tasks, and overwritten each time — it reflects the Task as currently understood, not a history of how that understanding changed.
_Avoid_: Objective, intent

**Previous Tasks**:
A Task File's list of the other Tasks in the *same Workspace* that already have their own Task File, shown chronologically with each one's Task Outcome as a one-sentence summary. Narrower than, and unrelated to, Sibling Progress — Previous Tasks never crosses a Workspace boundary and is read straight off the filesystem, never from a tracker or dependency link.
_Avoid_: Sibling tasks, related tasks (ambiguous with Sibling Progress), history

**Sibling Progress**:
The existing cross-Workspace record of Tasks related by a shared tracker link or a direct dependency edge, persisted in `task_progress_entries` and surfaced into a Run's opening message. Not read from or written to a Task File — a separate mechanism answering a separate question ("what else is this tied to," vs. Previous Tasks' "what already happened here").
_Avoid_: Previous tasks, related tasks

**Task Notes**:
A Task File's append-only log, grouped under one heading per Run, combining freeform notes an agent records mid-Run with mechanical entries describing each plan-step change. The only part of a Task File that keeps a full history rather than just the latest value.
_Avoid_: Agent notes, scratchpad, task log

**Task Outcome**:
A Task File's record of what happened on its most recent Run and whether it succeeded — holding exactly the summary text that Run's own ending already produced, never a separate telling of the same event.
_Avoid_: Result, summary (too generic — collides with a Run's own summary)

**Handoff Notes**:
A Task File's note to whichever Run comes next, written fresh at the end of each Run specifically to carry forward what that next Run should know or follow up on. Distinct from Task Outcome, which looks back at what happened; Handoff Notes looks forward at what to do about it.
_Avoid_: Next steps, follow-up notes
