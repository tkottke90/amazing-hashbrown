# Skills settings management UI

Issue: [tkottke90/amazing-hashbrown#116](https://github.com/tkottke90/amazing-hashbrown/issues/116)

## Problem

The **Skills** tab on the Settings page (`case 'skills'` in
`ui/src/pages/settings/index.tsx`) renders `PlaceholderPanel`
(`ui/src/pages/settings/placeholder-panel.tsx`), a static "Management UI
coming soon." message. There is no way to view, create, edit, enable/disable,
or delete skills from the UI today, even though the backend already has a
fully-featured `SkillsManager` (`lib/skills-manager`) capable of all of this
— it's simply never been wired up to anything but the read-only,
enabled-only `GET /api/v1/skills?q=` endpoint used by the chat slash-command
autocomplete (`ui/src/components/chat-input.tsx`).

## Goals

- Replace the Skills tab's placeholder with a real management UI.
- Users can see every installed skill, including disabled ones, with enough
  detail (description, slash command, enabled state) to know what it does
  without leaving the tab.
- Users can create a new skill, edit its frontmatter/body, enable/disable it,
  and delete it.
- Users can manage a skill's supporting files: arbitrary `scripts/` and
  `references/` files (add/edit/delete), and its `evals/evals.json` test
  cases (add/edit/delete individual cases) via a structured editor.
- The two built-in, tool-gated skills (`create-workspace`, `create-project`
  — see `api/src/agents/gated-skill-registrations.ts`) cannot be deleted
  through this UI, and disabling either one shows a warning naming the tool
  it will hide, since deleting/disabling them silently breaks
  `create_workspace`/`create_project` tool-gating for the chat agent.

## Out of scope (explicitly deferred)

- **Running eval suites from the UI.** Editing `evals/evals.json` (the test
  case definitions) is in scope; actually executing a suite (`runEval()`
  from `lib/evaluations`, the same machinery `bin/eval.ts` and the
  `auto-eval-loop` skill use) requires provider selection and can take
  minutes per run — that becomes its own follow-up issue with its own
  design (likely needing async job tracking / streaming status).
- Running a skill's `scripts/*.js`/`*.py` files from the UI
  (`SkillsManager.runScript`/`runPythonScript`) — those are agent-invoked
  at chat time, not something a settings admin needs to trigger manually.
- Skill *source* provenance (e.g. distinguishing skills installed via
  `skills-lock.json` from locally-created ones). `skills-lock.json` is not
  currently read by the API at all (only by whatever installs skills before
  boot); nothing in this design changes that. All skills are treated
  uniformly except the two gated ones named above.

## Backend: new routes on `api/src/routes/v1/skills.route.ts`

The existing route stays as-is:

```ts
GET /api/v1/skills?q=<keyword>
```

still calls `skillsManager.search(q)` (enabled-only), unchanged — this is
the contract `chat-input.tsx`'s autocomplete depends on.

New routes added to the same router, all backed directly by the
`skillsManager` singleton (`api/src/services/skills-manager.ts`):

| Method | Path | Manager call | Notes |
|---|---|---|---|
| GET | `/api/v1/skills?all=true` | `list()` | New query flag, additive — omitted/false preserves today's enabled-only behavior for existing callers. Admin list view uses `all=true`. |
| GET | `/api/v1/skills/:name` | `load()` | Full `Skill`: frontmatter, body, `scripts`/`references` basename→path maps. |
| POST | `/api/v1/skills` | `create(input)` | Body: `CreateSkillInput`. 409 on duplicate name (manager already throws on this — route maps to 409). 400 on invalid name (manager's `NAME_RE`/length checks — route maps to 400). |
| PATCH | `/api/v1/skills/:name` | `edit(name, changes)` | Body: `EditSkillInput` (`description`, `body`, `license`, `compatibility`, `allowedTools`, `metadata`, `enabled`). 404 if skill doesn't exist. |
| DELETE | `/api/v1/skills/:name` | `delete(name)` | **409 if `name` is in `GATED_SKILL_REGISTRATIONS`** (`api/src/agents/gated-skill-registrations.ts`), checked before calling into the manager — this is a real integrity guard, not just a UI nicety, so it's enforced server-side. |
| GET | `/api/v1/skills/:name/files/:dir/:basename` | `readFile(name, dir, basename)` | `dir` restricted to `scripts` \| `references` (validated, 400 otherwise). |
| PUT | `/api/v1/skills/:name/files/:dir/:basename` | `writeFile(name, dir, basename, content)` | Creates or overwrites. |
| DELETE | `/api/v1/skills/:name/files/:dir/:basename` | `deleteFile(name, dir, basename)` | |
| GET | `/api/v1/skills/:name/evals` | `loadEvals(name)` | Returns `{ skill_name: name, evals: [] }` instead of propagating the manager's "no evals found" error, so the frontend always has a valid (possibly empty) suite to render. |
| PUT | `/api/v1/skills/:name/evals` | `saveEvals(name, suite)` | Body: `EvalSuite`. |

All routes follow the existing router's error-handling shape (try/catch →
appropriate status + `{ error, detail }`, matching the current `GET /`
handler's pattern).

## Frontend

### Panel wiring

`ui/src/pages/settings/index.tsx`: `case 'skills'` renders a new
`SkillsPanel` instead of `<PlaceholderPanel title="Skills" />`.

### Layout

New file `ui/src/pages/settings/skills-panel.tsx`, structured like the
Settings page itself — a nested aside + main content area:

- **Aside** (skill list): fetched via `GET /api/v1/skills?all=true`. Each
  row shows name, truncated description, an enabled/disabled toggle switch
  (calls `PATCH /:name { enabled }` directly, no separate save step), and a
  small badge for the two gated skills. A "+ New skill" button at the top
  opens the create form in the main area. Clicking a row selects it.
- **Main content area**: renders whichever skill is selected, or the create
  form, or an empty state ("Select a skill or create a new one") on first
  load. Selected skill view has four tabs:
  - **Details** — frontmatter fields (description, license, compatibility,
    allowed-tools) via `Input`/`Textarea`, body in the existing CodeMirror
    markdown mode (`ui/src/pages/workspaces/code-editor.tsx`, reused
    as-is), an explicit Save button (`PATCH /:name`), and a Delete button.
    The skill's `name` is shown read-only — `SkillsManager.edit()` has no
    way to rename a skill (only `description`/`body`/frontmatter/`enabled`),
    so renaming isn't offered; a rename is delete-and-recreate under a new
    name if ever needed.
    Delete is disabled with an explanatory tooltip for gated skills;
    otherwise it opens a confirm dialog (reusing `Modal` from
    `@tkottke90/preact-dialog`, same pattern as the shell-approval-card
    redesign) before calling `DELETE /:name`.
  - **Scripts** / **References** — same component, parameterized by `dir`.
    Lists existing basenames (from the loaded `Skill.scripts` /
    `.references` maps) each with Edit (opens CodeMirror, language inferred
    from extension same as `code-editor.tsx` already does) and Delete
    (confirm dialog). An "Add file" control takes a filename + empty editor,
    saved via `PUT`.
  - **Evals** — structured list editor over `EvalSuite.evals`: each
    `EvalCase` renders as a card with `prompt`/`expected_output` textareas
    and an `assertions` list (add/remove lines), plus Add/Remove case
    buttons. One Save button PUTs the whole suite.

Enabling/disabling a gated skill's toggle (in the aside) shows a confirm
dialog naming the tool it gates (e.g. "Disabling this will hide the
`create_workspace` tool from the assistant.") before the `PATCH` fires;
confirming proceeds, canceling reverts the toggle visually.

### Service layer

New `ui/src/services/skills-manage-api.ts` with typed client functions for
every route above (`fetchAllSkills`, `fetchSkill`, `createSkill`,
`updateSkill`, `deleteSkill`, `fetchSkillFile`, `saveSkillFile`,
`deleteSkillFile`, `fetchSkillEvals`, `saveSkillEvals`). The existing
`ui/src/services/skills-api.ts` (chat autocomplete) is untouched — it's a
separate, narrower contract and shouldn't be conflated with the admin
surface.

A local constant mirrors `GATED_SKILL_REGISTRATIONS`'s skill names (e.g.
`GATED_SKILL_NAMES = ['create-workspace', 'create-project']`) for the
frontend's disable-delete-button / disable-warning logic. This is
UI-convenience only — the actual guard is the backend's 409, per the design
principle above of not relying on the UI to enforce it.

### Why not `useSettingsSection`

The Tools/Model-Providers/etc. panels treat their whole section as one JSON
blob with a two-step save/discard flow (`useSettingsSection`,
`SaveDiscardBar`). Skills don't fit that model: each skill is its own
independently-addressable resource backed by its own files on disk, with
its own create/read/update/delete lifecycle, plus nested sub-resources
(files, evals) with their own save actions. Reusing the single-blob
save/discard pattern here would mean fetching/diffing/saving the entire
skill list as one JSON document on every keystroke-adjacent action, which
doesn't match how the backend actually stores or mutates this data. Each
tab/action in this design saves and reports success/failure independently
(via the existing `showToast` helper), same as `ProviderModal`'s per-item
save inside the Model Providers panel already does.

## Error handling

- Name collisions and invalid names on create surface the manager's own
  error text (e.g. `Skill "x" already exists`) via `showToast('error', …)`.
- Gated-skill delete attempts: the Delete button is disabled client-side,
  but if the 409 is ever hit anyway (stale UI state), it's shown as a toast
  rather than crashing the panel.
- File/evals endpoints 404 cleanly when the parent skill doesn't exist
  (can't normally happen from the UI, but guards direct API misuse);
  missing `scripts`/`references` directories just render "No files yet."
  in their respective tabs.

## Testing

This codebase has no UI component unit tests — component behavior is
verified through Playwright e2e (see `e2e/tests/settings-*.spec.ts` for the
existing pattern) plus Mocha unit tests on the backend.

- **Backend**: new `api/src/routes/v1/skills.route.test.ts` (none exists
  today) covering every new route — success paths, 404s on unknown skill
  names, 409 on duplicate create, and specifically the 409 on deleting a
  gated skill.
- **Frontend e2e**: new `e2e/tests/settings-skills-panel.spec.ts` covering:
  navigating to the Skills tab and seeing the seeded default skills listed;
  creating a new skill and seeing it appear in the aside; editing and
  saving its description/body; toggling enabled/disabled; adding, editing,
  and deleting a script file; adding and removing an eval case; attempting
  to delete `create-workspace` and confirming the Delete button is disabled
  with a tooltip.
