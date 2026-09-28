# Skill-callable file tools: `activate_skill` + `file-ops`

**Date:** 2026-09-23
**Status:** Approved

## 1. Problem & Goal

Workspace Chat's only file-capable tool today is `shell_exec` (`api/src/agents/tools/shell-exec.tool.ts`) — a free-text `command` string spawned via `child_process`. Every file lookup or edit requires the model to generate exact shell syntax, and every invocation (absent an operator-configured allowlist) hits a human-approval gate, even for a plain read.

Two separate problems motivate this design:

1. **Friction and reliability.** Generating correct `find` syntax is unnecessarily hard for a local model to get right on the first try, and generating a correct `patch`/diff hunk is worse — real Unix `patch` requires exact context-line matching, and small local models are measurably worse at precise, structured syntax generation than frontier models. Wrapping these in nicer shell functions doesn't fix this: `shell_exec`'s schema is a bare `command: string`, so a wrapper is advisory, not enforced — nothing stops the model from falling back to raw `find`/`patch` anyway, and the policy/allowlist layer still has to defend against that regardless of what convenience wrappers exist alongside it.
2. **Tool-count cost on local models.** This project's local-first mission means targeting models running in constrained context windows (e.g. 40k on consumer hardware). Every bound tool schema costs real tokens on every turn for models without a separate tool-calling side-channel, and — independent of token budget — tool-selection accuracy measurably degrades as the number of always-visible tools grows, even in models with room to spare in context. Simply adding `find_file`/`edit_file`/`read_file` as always-bound tools would make every chat turn pay this cost, whether or not that turn ever touches a file.

**Goal:** give the agent schema-validated, reliable file tools (replacing raw `find`/`patch` generation) without growing the always-visible tool list for turns that don't need them.

## 2. Existing mechanism this builds on

The "Skill-Gated Tools" pattern already exists and already solves the exposure problem, for a **human-typed** trigger:

- `skill-expansion.middleware.ts`'s `beforeAgent` hook expands a slash command (`/create-workspace ...`) typed by the human into the skill's full instruction body, and — only when the command matches an entry in `GATED_SKILL_REGISTRATIONS` — sets `activeGatedSkill` in graph state.
- `skill-gated-tools.middleware.ts`'s `wrapModelCall` filters the model's visible tool list on every model call: a tool named in any registration is hidden unless its registration's `skillCommand` matches the current `activeGatedSkill`.
- `GATED_SKILL_REGISTRATIONS` (`api/src/agents/gated-skill-registrations.ts`) is the single source of truth mapping `skillCommand → toolNames[]`, read by both middlewares and by `bin/eval.ts`.
- Today's two entries (`create-workspace → create_workspace`, `create-project → create_project`) are both **human-invoked only** — the model has no way to open a gate itself. `search_skills` only lets it discover skill names to suggest to the user.

This design adds LLM-self-invocation on top of the existing mechanism, without touching its human-typed path, its state schema, or its middleware.

## 3. Design

### 3.1 `activate_skill` tool (new, always-visible)

A single generic gateway tool — not one bespoke "activate" tool per skill — consistent with the Skill-Gated Tools pattern's own composition principle (one mechanism other skills register into).

- Schema: `{ name: z.string() }` — a plain string, not a `z.enum`. An enum could let a validation failure short-circuit before the handler runs on backends that enforce it strictly, which would mean the handler never gets a chance to return a corrective message; a string guarantees the handler always runs and always controls the error text, and is testable without depending on framework-specific validation-error plumbing.
- Valid target set: skills present in `GATED_SKILL_REGISTRATIONS` **and** carrying `metadata.selfCallable === 'true'` on their stored skill record.
- On a valid name: looks up the skill body (`skillsManager.lookup`/`load`, same source the human-typed path already expands) and returns
  ```ts
  new Command({
    update: {
      activeGatedSkill: name,
      messages: [new ToolMessage({ content: <skill body>, tool_call_id, name: 'activate_skill' })],
    },
  })
  ```
  — mirroring `create_workspace.tool.ts`'s existing `Command`-based state write (today used to _close_ a gate; here used to _open_ one). Because this is a tool result, not a plain-text final answer, the ReAct loop continues automatically into a model call that already sees the newly gated tools via `skillGatedToolsMiddleware` — no new graph-control-flow work is needed for this to work.
- On an invalid or non-self-callable name: returns a plain string listing the valid self-callable skill names (same shape as `search_skills`'s no-match message and the existing "`Skill "/x" not found — use search_skills`" text in `skill-expansion.middleware.ts`) — not an exception, and no state change.
- Registered in `TOOL_CATALOG` as `category: 'built-in'`, `alwaysOn: true` — it must be visible before any skill is active, since it's the only way one becomes active.

**Why not have the assistant self-trigger via plain text** (e.g. widening `skill-expansion.middleware.ts` to also scan the latest assistant message for a leading `/command`, avoiding a new tool entirely) — considered and rejected:

- The graph doesn't continue after a plain-text assistant message with no tool call; that's treated as the final answer and streamed to the user as-is. Making a text-triggered version work would require new loop-continuation control flow between model calls within a turn, which doesn't exist today.
- Free text has no structural constraint the way a tool call does; requiring the model to reproduce `/skill-name` byte-exact in a message that starts with nothing else is a harder target for a weak local model to hit reliably than a one-field tool call, not an easier one.
- It also forces the model to suppress normal narration (the parser requires the message to _start_ with `/`), and introduces a false-positive risk that doesn't exist on the human side: an assistant's real answer that happens to start with `/` (a path, a snippet) could be misparsed as a failed skill invocation and have its actual content silently replaced.
- The presumed token savings (prose in the system prompt vs. a tiny schema) aren't guaranteed either — a policy description in prose is not obviously smaller than a one-field enum/string schema.

### 3.2 `file-ops` skill (new, self-callable)

- New entry in `default-skills.ts`'s `DEFAULT_SKILLS`, with `metadata: { selfCallable: 'true' }`. This uses the `metadata: Record<string, string>` field `CreateSkillInput`/`EditSkillInput` already support (`skills.handlers.ts`'s `CreateSkillSchema`/`EditSkillSchema`) — no changes needed to the external `@tkottke90/skills-manager` package.
- **Self-callable is a per-skill, deliberate opt-in, not a default** — set by the application for its own built-in skills (this one, in `default-skills.ts`), or by a user on their own custom skill through the existing skill editor (same `metadata` field, already editable via `PATCH` to the skill). No skill becomes self-callable just by being gated; both must be true.
- New `GATED_SKILL_REGISTRATIONS` entry: `{ skillCommand: 'file-ops', toolNames: ['find_file', 'read_file', 'edit_file'] }`.
- Body instructs the model on when to call `activate_skill({ name: 'file-ops' })` (needs to locate, read, or modify a file in the workspace) and does not assume all three tools are necessarily present — see §3.4 on per-tool disable.
- **Gate persistence:** unlike `create_workspace`/`create_project` (one-shot terminal actions that clear `activeGatedSkill` back to `null` on success), none of `find_file`/`read_file`/`edit_file` clear the gate. File work is iterative (find → read → edit → maybe find again), so the gate should stay open across multiple tool calls in the same flow. This needs no new logic — it's exactly the "gate persists across non-slash-command turns" behavior `skill-expansion.middleware.ts` already relies on for the existing multi-turn flows (see the `2026-08-27` hardening design's Fix 1); the file tools simply never write `activeGatedSkill` themselves.

### 3.3 The three tools

All three bind to `workspaceContext.location` the same way `makeShellExecTool(workingDirectory)` already does, and reuse the existing path-containment checks (`resolveWorkspaceLocation`/`resolvePathUnderRoot`) rather than reimplementing traversal protection. None go through `ShellExecutor`'s `evaluatePolicy`/`interrupt` approval gate — that gate exists specifically to police arbitrary shell text, and these tools' capability is already fixed by their Zod schema.

- **`find_file`** — `{ pattern: string, path?: string }`. Direct filesystem walk/glob in Node, no shell invocation. Empty result set returns a plain "no files matched" string, not an error.
- **`read_file`** — `{ path: string }`. Returns file contents. Missing/unreadable path returns a plain error string.
- **`edit_file`** — `{ path: string, old_string: string, new_string: string }`. Exact-match SEARCH/REPLACE — this is the tool replacing raw `patch` generation. Rejects (plain error string, no partial write) when `old_string` matches zero or more than one location in the file, per the same reasoning that led other agent harnesses (Aider, Codex's `apply_patch`) away from context-line-based diffs toward exact-string matching for LLM-generated edits.

Each is registered in `TOOL_CATALOG` as `category: 'skill-gated'`, `skillCommand: 'file-ops'`, `alwaysOn: false` — the same shape `create_workspace`/`create_project` already use.

**Explicitly out of scope for this round:** a `grep_workspace`/in-file content search tool. Nothing so far has established a concrete need for it, and adding it speculatively goes against the repo's own YAGNI principle. Adding it later is a small, additive follow-up: new tool file, append its name to the existing `file-ops` registration entry.

### 3.4 Per-tool disable (existing mechanism, no changes needed)

Because each of the three tools is an ordinary `TOOL_CATALOG` entry, the existing tool-settings system (`tool-config.ts`'s `enabled`/`defaultInclude`, editable through the tool-settings UI/API) already lets a user disable, say, `read_file` alone without affecting `find_file`/`edit_file` or the `file-ops` skill's ability to activate. This is orthogonal to skill-gating: `skillGatedToolsMiddleware` only filters whatever tools are already bound, so a globally-disabled tool is simply never in that set — no conflict, no new plumbing.

This does **not** reduce the baseline token cost for sessions that never touch files — that cost is already zero, since none of the three tools are visible until `file-ops` is activated. What it buys is a knob for someone who uses `file-ops` regularly but finds one specific tool unreliable or unnecessary on their model.

### 3.5 Tool friction metrics

To make "is this tool causing problems for this model" answerable with data rather than guesswork:

- **`v_tool_friction` view** (new, in `lib/observability`, alongside `CostStore`'s existing `v_usage` view and migration versioning):
  ```sql
  CREATE VIEW IF NOT EXISTS v_tool_friction AS
  SELECT
    s.name                                                AS tool_name,
    date(s.started_at)                                    AS date,
    COUNT(*)                                              AS call_count,
    SUM(CASE WHEN s.error IS NOT NULL THEN 1 ELSE 0 END)  AS error_count
  FROM observability_spans s
  WHERE s.type = 'tool-call'
  GROUP BY s.name, date(s.started_at);
  ```
  Requires no new capture logic — `ObservabilityCallbackHandler`'s `handleToolStart`/`handleToolEnd`/`handleToolError` already record a span (with `name`, `error`) for every tool call automatically, the moment a tool is bound to the agent. Lands in a new small class alongside `CostStore` (e.g. `ToolFrictionStore`) rather than added to `CostStore` itself — friction and cost are different concerns that happen to share the same underlying table.
- **`GET /api/v1/metrics/tool-friction`** — new `metricsRouter` (`api/src/routes/v1/metrics.route.ts`) mounted at `/metrics` in `routes/v1/index.ts`, paired with plain handler functions in `metrics.handlers.ts` (same route+handlers split as `skills.route.ts`/`skills.handlers.ts`, `workspaces.route.ts`/`workspaces.handlers.ts`). The router owns the `/metrics` namespace rather than being named after this one metric, so a future metrics endpoint is "add a handler, register it here" rather than "add another one-off router file." `GET /tool-friction` accepts `from`/`to` (default last 30 days, same convention as `usage.route.ts`) and an optional `toolName` filter; response shape mirrors `usage.route.ts`'s: `{ from, to, rows: [{ toolName, date, callCount, errorCount }], totals }`.
- **Explicitly out of scope:** any UI for this data — no dashboard card, no tool-settings-drawer badge. The endpoint exists for direct/manual pulls only; a UI is a separate future decision.

### 3.6 Shell-vs-tool file-op adoption metric

A second, related question: is `file-ops` actually displacing file work the model would otherwise have done through `shell_exec`? Unlike §3.5, this requires **classifying free-text shell commands**, which is inherently a heuristic, not an exact count — flagged here explicitly so the resulting numbers are read as a directional signal, not a precise measurement.

- **Classification happens once, at write time, inside `ShellAuditStore.write()`** (`shell-audit.ts`) — not re-derived per query with fragile `LIKE` clauses. A small pure classifier function takes `entry.command` and returns three independent booleans, not a single category: a real-world `shell_exec` command is frequently a chain (`cat file.txt && sed -i 's/x/y/' file.txt`, `find . -name '*.ts' | xargs grep foo`) mixing a read, a write, and/or an unrelated action in one call. A single enum column would force one bucket per call and silently lose that a command did more than one kind of thing; three booleans let a single row be `is_file_read = true` and `is_file_write = true` at once, and `is_other = true` records that the command also contained a fragment that wasn't classified as file read/write (distinct from simply "neither read nor write matched" — a command can be a real file read _and_ also do something else in the same chain).
  - Approach: split the command on shell separators (`&&`, `||`, `;`, `|`), classify each fragment by its leading verb/redirection operator against known read verbs (`cat`, `head`, `tail`, `less`, `more`, a bare `find`) and write verbs/operators (`patch`, `sed -i`, `tee`, `cp`, `mv`, `touch`, `rm`, `>`, `>>`), and set each boolean true if any fragment matched that bucket.
  - No changes needed to `@tkottke90/shell-executor`'s `AuditEntry` type — the classifier runs entirely inside this repo's own `ShellAuditStore.write()`, using the `command` text `AuditEntry` already carries.
- **`shell_audit_log` migration** (new version, following the existing version-17 migration in `shell-audit.ts`): three new columns, `is_file_read INTEGER NOT NULL DEFAULT 0`, `is_file_write INTEGER NOT NULL DEFAULT 0`, `is_other INTEGER NOT NULL DEFAULT 0` — booleans-as-integers, matching the existing `trust_all` column's convention in the same table.
- **`v_file_tool_adoption` view** (same DB as `v_tool_friction` — confirmed both `bootObservability(db)` and `bootShellAudit(db)` share one `db` instance, `index.ts:34,36` — so this view can compare the two tables directly):

  ```sql
  CREATE VIEW IF NOT EXISTS v_file_tool_adoption AS
  SELECT
    date(s.started_at)                                             AS date,
    'file-ops'                                                     AS source,
    SUM(CASE WHEN s.name IN ('find_file','read_file') THEN 1 ELSE 0 END) AS read_count,
    SUM(CASE WHEN s.name = 'edit_file' THEN 1 ELSE 0 END)          AS write_count
  FROM observability_spans s
  WHERE s.type = 'tool-call' AND s.name IN ('find_file', 'read_file', 'edit_file')
  GROUP BY date(s.started_at)

  UNION ALL

  SELECT
    date(a.timestamp)                                              AS date,
    'shell_exec'                                                   AS source,
    SUM(CASE WHEN a.is_file_read  = 1 THEN 1 ELSE 0 END)          AS read_count,
    SUM(CASE WHEN a.is_file_write = 1 THEN 1 ELSE 0 END)          AS write_count
  FROM shell_audit_log a
  GROUP BY date(a.timestamp);
  ```

  One row per `(date, source)`, so `file-ops` vs. `shell_exec` read/write counts sit side by side for the same day — a fallback ratio, not just a raw count.

- **`GET /api/v1/metrics/file-tool-adoption`** — a second handler on the same `metricsRouter` (§3.5), same `from`/`to` convention, response `{ from, to, rows: [{ date, source, readCount, writeCount }] }`.
- **Explicitly out of scope:** no UI, same as §3.5. Also out of scope: tuning the classifier's verb list beyond a reasonable starting set — it's expected to need refinement once there's real `shell_audit_log` data to check it against.

## 4. Data flow

1. Model decides it needs file access, calls `activate_skill({ name: 'file-ops' })`.
2. Tool validates the name, returns a `Command` setting `activeGatedSkill: 'file-ops'` plus a `ToolMessage` carrying the skill body.
3. The tool result keeps the ReAct loop going; the next model call in the same turn already sees `find_file`/`read_file`/`edit_file` (whichever are enabled) via `skillGatedToolsMiddleware`.
4. Model calls whichever of the three tools it needs, in any order, across one or more turns — the gate does not close on its own.
5. The gate closes only the way every other gated skill's does today: a new human-typed slash command (gated or not) resets `activeGatedSkill` per `skill-expansion.middleware.ts`'s existing logic. Abandoning a `file-ops` flow via plain chat (no new slash command) leaves the gate open for the rest of the thread — this is pre-existing, accepted residual risk from the `2026-08-27` hardening design, not something this feature changes or needs to re-solve.

## 5. Error handling

- `activate_skill` with an unrecognized or non-self-callable name → plain string listing valid self-callable skill names, no state change.
- `find_file` with no matches → plain string, not an exception.
- `read_file` on a missing/unreadable path → plain string error.
- `edit_file` with zero or multiple matches for `old_string` → plain string explaining which, and why; no partial write.
- All three file tools reuse `resolveWorkspaceLocation`/`resolvePathUnderRoot` for containment; no path outside the bound workspace root is ever reachable through them, regardless of `path`/`pattern` input.
- None of the three go through `ShellExecutor`'s approval gate; `activate_skill` doesn't either, since its capability (opening a gate to schema-validated tools) is not the kind of arbitrary action that gate exists to police.

## 6. Testing

- Unit tests per tool (`find-file.tool.test.ts`, `read-file.tool.test.ts`, `edit-file.tool.test.ts`, `activate-skill.tool.test.ts`): happy path, no-match/empty result, path-traversal attempt, and (for `edit_file`) the non-unique-match rejection.
- Extend `skill-gated-tools.middleware.test.ts` and `skill-expansion.middleware.test.ts` with cases for the new `file-ops` registration entry, following the existing test shapes for `create-workspace`/`create-project`.
- New eval suite `suites/file-ops.yaml`, using the `gatedSkill` scenario field the `2026-08-27` hardening design already added to the eval harness for exactly this purpose: scenarios covering (a) activating `file-ops` then calling `find_file`, (b) `edit_file` receiving an ambiguous `old_string`, (c) confirming the three file tools are _absent_ when `file-ops` has not been activated in that scenario's state.
- `ToolFrictionStore`/`v_tool_friction` gets the same unit-test treatment `CostStore`/`v_usage` already has (migration applies, view returns expected aggregates against seeded spans).
- Shell-command classifier (§3.6): unit tests per bucket — a pure read command, a pure write command, an unrecognized/`other` command, and (the case motivating three independent booleans) a chained command mixing read and write in one call (`cat file.txt && sed -i ... file.txt`), asserting both booleans land `true` on the same row.
- `v_file_tool_adoption` view gets the same treatment as `v_tool_friction` — seeded rows in both `observability_spans` and `shell_audit_log`, asserting the view's per-`(date, source)` counts match.
- `metrics.handlers.ts`'s handler function(s) get orchestration-level tests via `supertest`, matching `usage.route.ts`'s existing test coverage shape — covering both `/tool-friction` and `/file-tool-adoption`.
- `npm test` / `npm run lint` / `npx prettier --check .` before pushing, per repo convention.

## 7. Out of scope / non-goals

- `grep_workspace` / in-file content search — no established need yet; a trivial follow-up if one emerges (§3.3).
- Any UI for tool-friction metrics — API only (§3.5).
- Migrating `create-workspace`/`create-project` to also be `activate_skill`-callable — nothing requires it, and their existing human-typed-only flow is unaffected by this design. Could be a follow-up if there's ever a reason for the model to self-trigger workspace/project creation, but that's a different judgment call (arguably higher-stakes actions than reading/finding/editing a file) not needed to ship this.
- Any change to `ShellExecutor`, its policy/allowlist engine, or `shell_exec` itself — it remains the escape hatch for everything these three tools don't cover.
