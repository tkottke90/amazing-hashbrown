# Todoist Tracker Adapter Design

**Date:** 2026-11-24
**Status:** Draft, awaiting review
**Issue:** [tkottke90/amazing-hashbrown#82](https://github.com/tkottke90/amazing-hashbrown/issues/82)

## Goal

Add Todoist as the second built-in tracker adapter, next to GitHub. A user can link a hashbrown task to an existing Todoist task, or create a Todoist task from the task drawer. The linked item's title, Canonical State, and due date show live in the drawer, and the item carries an Assignee Label (`AH:User` / `AH:Agent`) that tracks the task's `assignedTo`.

Terms used below are defined in `GLOSSARY.md` under **External Trackers**: Tracker Link, Canonical State, Configured Tracker, Tracker Container, Assignee Label.

## Corrections to the issue

The issue was written before #73 landed and against an API version Todoist has since replaced. These replace the issue's Developer Notes where they conflict:

- **API version.** Use Todoist's unified API at `https://api.todoist.com/api/v1/`, not REST v2. IDs are opaque alphanumeric strings, and old numeric IDs are rejected.
- **Registration.** Adapters are built in `buildTrackerRegistry()` (`api/src/services/tracker-registry.ts`), not `api/src/index.ts`. The registry is already rebuilt on every settings PATCH.
- **State sync.** Tracker state is never stored. The drawer fetches it live on open (`ui/src/components/task-drawer.tsx`), so there is nothing to sync for display.
- **Registration gating.** "Not registered without a token" would hide Todoist from Settings, which is the only place a token can be entered. Todoist is always registered, and gating moves to a `configured` flag (below).
- **State mapping.** Todoist active maps to `pending`, not `in_progress`. That matches GitHub's open → `pending`, and an active task says nothing about whether work has started.

## Scope

### In scope

1. Todoist adapter: link, create, live display (title, Canonical State, due date)
2. `configured` flag on tracker summaries, used to filter the drawer's tracker select
3. Tracker Container: generic replacement for `createItem`'s GitHub-only `repo`, with optional container listing
4. `dueAt` on `TrackerItem`
5. Todoist token in Settings, with a Verify button
6. Assignee Labels on linked Todoist items, kept current on every reassignment

### Out of scope (follow-up issues, filed after this spec is approved)

- Todoist state sync via webhooks. Webhooks require a registered OAuth app, a public HTTPS endpoint, and a per-user OAuth flow; a personal token can't activate them.
- GitHub `updateState` write-back.
- Todoist `updateState` write-back (close / reopen).

## Adapter interface changes (`api/src/services/tracker-adapter.ts`)

```ts
type Assignee = 'user' | 'agent' | null;

interface TrackerItem {
  // existing fields unchanged
  dueAt: string | null; // YYYY-MM-DD; GitHub always null
}

interface TrackerContainer {
  id: string; // GitHub "owner/repo"; Todoist project id
  name: string;
}

interface TrackerAdapter {
  // existing fields unchanged
  configured: boolean; // has what it needs to answer requests
  createItem(params: {
    title: string;
    body?: string;
    container?: string; // replaces `repo`
    dueAt?: string | null;
  }): Promise<TrackerItem>;
  listContainers?(): Promise<TrackerContainer[]>;
  setAssignee?(id: string, assignee: Assignee): Promise<void>;
}
```

- `repo` → `container` is a breaking change for `TRACKER_PLUGINS` packages. There are none in this repo. Call it out in the release notes.
- GitHub: `configured: true` always (it works read-only without a token), `dueAt: null`, takes `container` as `owner/repo`, and implements neither optional method.
- `GET /api/v1/trackers` summaries gain `configured`.
- New route `GET /api/v1/trackers/:type/containers`: returns `404` if the adapter is unregistered and `400` if it doesn't implement `listContainers`.
- `POST /trackers/:type/items` accepts `container` and `dueAt`.
- `resolveTrackerUrlAnyAdapter` skips adapters with `configured: false`.

## Todoist adapter (`api/src/adapters/tracker-todoist.ts`)

`createTodoistTrackerAdapter(token?: string)`, registered unconditionally in `buildTrackerRegistry()` with `env.workspaces.tasks?.trackers?.todoist?.token`.

| Property             | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `type`               | `'todoist'`                                                             |
| `configured`         | `Boolean(token)`                                                        |
| `canCreate`          | `Boolean(token)`                                                        |
| `authSchema`         | one `token` field: `password`, `required: true`, `supportsEnvRef: true` |
| Auth header          | `Authorization: Bearer {token}`                                         |
| Unconfigured methods | every method throws `Todoist adapter is not configured`                 |

### State mapping

| Todoist                                      | Canonical | `trackerState` |
| -------------------------------------------- | --------- | -------------- |
| returned by `GET /tasks/{id}`                | `pending` | `active`       |
| found by the completed-task scan (see below) | `done`    | `completed`    |

Recurring tasks move to their next occurrence when closed, so they always read as `pending` with a moving due date. This is intended, not a bug.

### Due date

`dueAt` is the date part of Todoist's `due` object (`due.date`, sliced to `YYYY-MM-DD`), or `null` when there is no `due`. This matches the drawer's date-only `dueAt` input.

### `resolveUrl(url)`

1. Match `^https?://app\.todoist\.com/app/task/([A-Za-z0-9]+)/?$`. If it doesn't match, throw `Not a recognised Todoist task URL`. This keeps `resolveTrackerUrlAnyAdapter` failing fast and locally for other trackers' URLs.
2. `GET /api/v1/tasks/{id}`. On `404`, throw `Todoist task is completed or doesn't exist`. A finished task can't be linked.

### `getItem(id)`

1. `GET /api/v1/tasks/{id}`. On `200`, map it as active.
2. On `404`, walk `GET /api/v1/tasks/completed/by_completion_date` with `since` = now − 3 months and `until` = now, following `next_cursor`, and match `id`. If it's found, map it as completed.
3. If it isn't found, throw. The drawer's existing best-effort handling keeps showing the stored link.

### `createItem(params)`

`POST /api/v1/tasks` with `content` = `title`, `description` = `body`, `project_id` = `container` (omitted → Todoist's Inbox), and `due_date` = `dueAt` (omitted when null). The Assignee Label is not written here: the auto-link that follows creation fires the store hook, and the Assignee Label service writes it (below).

### `listContainers()`

Walk every page of `GET /api/v1/projects?limit=200` via `next_cursor` and return `{ id, name }` for each project.

### `setAssignee(id, assignee)`

1. Desired label: `'user'` → `AH:User`, `'agent'` → `AH:Agent`, `null` → none. The names are hardcoded constants.
2. If a label is desired, make sure it exists: list the user's personal labels (`GET /api/v1/labels`) and `POST /api/v1/labels` if it's missing. The API docs don't say whether unknown names get auto-created.
3. Read-modify-write the task's labels: `GET /api/v1/tasks/{id}`, drop every label starting with `AH:`, add the desired one, then send the full list via `POST /api/v1/tasks/{id}`. Labels the user added themselves are always preserved.
4. A `404` (completed or deleted task) is a no-op, not an error.

## Assignee Label service

### Store hook (`api/src/services/workspace-store.ts`)

The store gets one listener registration, `onTaskTrackerAssignmentChanged(listener)`. It fires synchronously after `createTask` / `patchTask` commits, whenever a task's `assignedTo`, `trackerType`, or `trackerId` changed. It passes `{ before, after }` snapshots of `{ assignedTo, trackerType, trackerId }`, where `before` is `null` on create.

The store makes no network calls. It only notifies. This single choke point covers every assignment path: the board, task PATCH, HITL answers, AfterAgent, dependency unblocks, cron fires, webhooks, and the store's own internal patches. Per-route calls would miss the internal ones.

### Service (`api/src/services/tracker-assignee-labels.ts`)

It subscribes at boot and, for each event, fires and forgets using `getTrackerRegistry()`:

| Change                                 | Action                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| Link added (including create-and-link) | `setAssignee(after.trackerId, after.assignedTo)`                   |
| `assignedTo` changed, link unchanged   | `setAssignee(after.trackerId, after.assignedTo)`                   |
| Link removed                           | `setAssignee(before.trackerId, null)`                              |
| Link moved to a different item         | `setAssignee(before.trackerId, null)`, then set it on the new item |
| Task deleted                           | nothing (the stale label is harmless and deletes are rare)         |

- Skip adapters that are unregistered, not `configured`, or that don't implement `setAssignee`. That makes this a no-op for GitHub today.
- Failures, such as the free-plan label limit or a network error, are logged and swallowed. The originating create, link, or reassignment always succeeds.

## Verify (`POST /api/v1/trackers/todoist/verify`)

A dedicated route with its own result shape, registered before the `/:type` routes, the same way as GitHub's. Handler: `verifyTodoistTokenHandler({ token })` → `GET /api/v1/projects?limit=1`.

- `200` → `{ valid: true }`
- otherwise → `{ valid: false, error }`
- a missing token → `400`

UI: `tracker-config-modal.tsx` replaces `tracker.type === 'github'` and the hardcoded `verifyGithubToken` call with a small `type → verify function` map. A tracker shows a Verify button only if it has an entry. The success and error messages come from that entry.

## Config & settings

- `api/src/config/env.ts`: add `TodoistTrackerSchema = z.object({ token: z.string().optional() })` and `todoist: TodoistTrackerSchema.optional()` to `TrackersConfigSchema`.

  ```yaml
  workspaces:
    tasks:
      trackers:
        todoist:
          token: ${TODOIST_TOKEN} # or a literal value
  ```

- `settings.handlers.ts` `trackers` slug: add `todoist` alongside `github` in `TrackersSettings`, the GET (`displayCredential`, masked), the patch schema, and the PATCH (`unmaskApiKey` merge). The existing `reloadTrackerRegistry()` call after PATCH picks up the new token without a restart.

## UI

### Settings (`trackers-section.tsx`)

No structural change. Todoist now appears because it's always registered. While it's unconfigured, the row's badge reads **Not configured** instead of "Link only" / "Link & create".

### Task drawer (`task-drawer.tsx`)

- **Tracker type select:** lists only trackers with `configured: true`. A task already linked to a tracker that's since become unconfigured keeps its stored link, with the live fetch failing silently (existing behaviour).
- **Link preview and linked display:** show the due date when `dueAt` is non-null.
- **Create mini-form:**
  - The title is prefilled from the task title, with an optional description.
  - **Container input:** shown when the selected tracker implements `listContainers` (known from a `GET /trackers/:type/containers` call made when the form opens), as a select defaulting to **Inbox** (no `container` sent). If that fetch fails, the select shows Inbox only, with an inline error, and the form can still be submitted. Otherwise it falls back to the existing free-text field, which for GitHub stays prefilled from the workspace remote.
  - **Submit:** sends `{ title, body, container, dueAt: <task's dueAt> }`, then auto-links as today.
- `ui/src/services/trackers-api.ts`: add `configured` to `Tracker`, `dueAt` to `TrackerItem`, `listTrackerContainers()`, `verifyTodoistToken()`, and the new `createTrackerItem` params.

## Testing

All test names are tagged per `AGENTS.md`. Tests sit next to their source files.

- **`tracker-todoist.test.ts`** [external-orchestration], against Todoist API v1 (2026-11) response shapes, with `fetch` mocked:
  - outbound contract (method, path, Bearer header, body) for every endpoint used
  - `resolveUrl`: valid URL, non-Todoist URL rejected without a network call, `404`
  - `getItem`: active, `404` → found in the completed scan, `404` → not found, multi-page completed scan
  - `createItem`: with and without a project or due date
  - `listContainers`: multi-page walk
  - `setAssignee`: label missing → created; existing user labels preserved; `AH:User` swapped for `AH:Agent`; `null` removes the label; `404` no-op
  - unconfigured adapter throws
  - `due` → `dueAt` mapping
- **`tracker-github.test.ts`** [unit]: `container` replaces `repo`, `dueAt: null`, `configured: true`.
- **Store hook** [unit]: fires on `assignedTo`, `trackerType`, or `trackerId` changes from both `createTask` and `patchTask`, with correct `before`/`after`; does not fire for unrelated patches.
- **`tracker-assignee-labels.test.ts`** [orchestration]: each row of the action table; skips unconfigured adapters and adapters without `setAssignee`; a rejected `setAssignee` doesn't propagate.
- **Handlers** [unit]: containers route (unregistered `404`, unsupported `400`, success), `verifyTodoistTokenHandler`, `configured` in `listTrackersHandler`, new create params passed through, `resolveTrackerUrlAnyAdapter` skipping unconfigured adapters.
- **Settings handlers** [unit]: todoist token masked on GET, unmask-merged on PATCH.
- **UI (Jest):** verify map picks the right function; drawer filters unconfigured trackers; container select/free-text switch; Inbox fallback on fetch error.
- **E2E (Playwright)**, a new `Todoist tracker workflow` suite mirroring `002-GitHubTrackerWorkflow.spec.ts`, with `page.route()` mocking `/api/v1/trackers*`:
  - configure the token and verify
  - Todoist hidden from the drawer select while unconfigured
  - paste a URL → preview with due date → save → linked display
  - create with the project selector → auto-linked
  - project list failure → Inbox-only, still submits
- **Manual check during implementation:** confirm against a real Todoist account that `AH:User` (with the colon) is an accepted label name. The docs don't say.
- **No eval scenario.** No LLM-facing behaviour changes. `create_tasks`'s `trackerUrl` already resolves through `resolveTrackerUrlAnyAdapter`.
