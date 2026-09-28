# Workspace Dedicated Wiki & Scoped Wiki Writes

**Date:** 2026-09-28
**Status:** Draft
**Related:** [Issue #202](https://github.com/tkottke90/amazing-hashbrown/issues/202), #71 (Wiki Binding field), #149 (repo-derived wiki generation), [Project wiki write restriction (#79)](2026-08-26-project-wiki-write-restriction-design.md) — this spec generalizes that restriction

---

## Problem

Two gaps keep notes from a long-lived, repo-backed workspace from staying with that repo:

1. **No way to get a dedicated wiki without becoming a Project.** The workspace creation form's Wiki Binding select only offers "None" or an existing domain. Projects auto-provision a wiki, but require an end goal and destroy the wiki when the workspace is deleted.
2. **A bound wiki is only a hint, and AfterAgent ignores it.**
   - `resolveAllowedWikiId` (`api/src/agents/workspace-chat-stream-handler.ts:47`) only locks wiki writes for **Project** workspaces. For a plain workspace the bound wiki is a system-prompt suggestion, and the chat agent can write to any domain.
   - The AfterAgent pipeline (`api/src/agents/after-agent.ts`) runs after every workspace-chat turn (`chat-agent.ts:512`). It lets the LLM pick a target from _every_ registered domain and writes with no scope at all (`after-agent.ts:447`, `:461`), even for Project workspaces.

   Example: an "Image Archive" workspace and a "Video Streaming" workspace both use NodeJS and each has a wiki. A turn about NodeJS in Image Archive can be auto-filed into Video Streaming's wiki or into `user`.

## Guiding rule

LLM Wiki gives the agent two modes: **a known domain** or **go looking for the right one**.

- A workspace with a bound wiki is a known domain, so writes are locked to it.
- A workspace without a bound wiki goes looking, but never into a wiki another workspace owns.
- Global contexts go looking across everything, as today.

This feature adds more "known domain" cases and makes every write path respect them.

## Goals

- The workspace creation form (Workspace mode) can create a new, named, persistent wiki and bind it in one atomic step.
- The new wiki is a normal domain. It is not ephemeral, it can be bound elsewhere later, and it survives workspace deletion.
- Every wiki write from a workspace-chat thread (agent tools _and_ AfterAgent) is confined by one shared scope rule.
- AfterAgent fails closed when it can't tell where it is running.
- The `create_workspace` agent tool can do the same as the UI.

## Non-goals

- "Create new wiki" from the workspace settings drawer for existing workspaces.
- Projects binding a persistent (non-ephemeral) wiki instead of auto-provisioning one. This is a real gap, to be filed as a separate issue.
- Restricting wiki **reads**. `wiki_search`, `wiki_read_page`, and `wiki_orient` keep covering every domain.
- Any change to Project-mode creation or to project close/fold-in behavior.

---

## Design

### 1. Wiki creation on workspace create

**API: `createWorkspaceHandler`** (`api/src/routes/v1/workspaces.handlers.ts`)

- The body accepts `newWiki?: { name: string }`.
- Validation happens up front, before any side effects:
  - `newWiki` together with a non-null `wikiId` → 400 `Choose an existing wiki or create a new one, not both.`
  - `newWiki.name` missing or not a string → 400.
  - `id = wikiIdFromName(newWiki.name)`: `slugify` from `projects.handlers.ts` capped at 60 characters with trailing dashes trimmed, matching the UI's `slugify` (`ui/src/lib/utils.ts`) so the client-side collision check agrees with the server. An empty id → 400 `Wiki name must contain letters or numbers.`
  - `id` already present in `registry.list()` → 409 `A wiki named "<id>" already exists.`
- Order of operations:
  1. Validation (above, plus the existing name, location, and duplicate-workspace checks).
  2. Directory creation, git provisioning, and dependency isolation (unchanged).
  3. If `newWiki` was sent: `reg.create({ id, name: newWiki.name, domain: newWiki.name })`, with **no `metadata`**, so the wiki is not ephemeral.
     - `reg.create` throws "already registered" (a race) → roll back the directory and return 409 with the same message as above.
     - Any other error → roll back the directory and return 500 with the error message.
  4. `store.createWorkspace({ …body without newWiki, location, wikiId: id })`.
     - If it throws → best-effort `reg.destroy(id)` (only if step 3 created it) and best-effort directory removal, each logged on failure; return 500.
     - This also gives the existing no-wiki path the directory rollback it lacks today.
- The handler takes an optional `registry?: WikiRegistry` parameter (defaulting to `getWikiRegistry()`), matching `createProjectHandler` and `deleteWorkspaceHandler`.
- `rollbackDirectory` and `serverError` in `projects.handlers.ts` are exported and reused rather than duplicated.
- The route passes `newWiki` through. The `domain` field is the entered name, because the UI's domain select labels options by `domain`.

**Retention.** No change needed. `deleteWorkspaceHandler` destroys the bound wiki only when the workspace has a project.

**UI: workspace creation form** (`ui/src/pages/workspaces/index.tsx`, Workspace mode only)

- Add a sentinel `NEW_WIKI_VALUE = '__new__'` option, labelled **Create new wiki…**, after "None".
- When it's selected, a **Wiki name** text input appears below the select.
  - It is prefilled from the workspace name and follows it until the user edits the wiki name. After that it stops following.
  - Inline error when `slugify(wikiName)` is empty, or matches an `id` in the already-loaded `wikiDomains`: `A wiki named "<id>" already exists.` Submit is disabled while an inline error shows.
- On submit, the form sends `newWiki: { name }` and omits `wikiId`. A server 409 or 500 is shown through the form's existing error display.
- Helper text under the select changes from "Sets the first lookup, not an exclusive scope." to **"Notes from this workspace are written only to this wiki."**
- Project mode is unchanged.
- The name input and its validation live in a small new component, `ui/src/pages/workspaces/new-wiki-name-field.tsx`. It exports a pure `newWikiNameError(name, existingIds)` helper, so `index.tsx`, which is already large, only composes it.
- State uses `useSignal`/`useComputed`, per `ui/AGENTS.md`.

**Agent tool: `create_workspace`** (`api/src/agents/tools/create-workspace.tool.ts`)

- Add an optional `newWikiName: string` to the schema, described as creating a new dedicated wiki with that name and binding it.
- `newWikiName` together with `wikiId` → return an error string asking the agent to pick one.
- Otherwise pass `newWiki: { name: newWikiName }` to `createWorkspaceHandler`. The handler's 400 and 409 messages are returned verbatim, as today.
- The `create-workspace` skill text (`api/src/services/default-skills.ts`) gains one line telling the agent it can offer a new dedicated wiki as an alternative to binding an existing one.

### 2. Wiki write scope

**New unit: `api/src/services/wiki-write-scope.ts`**

```ts
export type WikiWriteScope =
  | { kind: 'locked'; wikiId: string }
  | { kind: 'open'; excludedWikiIds: string[] }
  | { kind: 'unresolved' };

export function resolveWikiWriteScope(
  context: { threadId: string; workspaceId?: string },
  stores?: { workspaceStore?: WorkspaceStore; threadStore?: ThreadStore },
): WikiWriteScope;

export type WikiWriteDenial = 'locked' | 'owned-by-another-workspace' | 'unresolved';

export function checkWikiWrite(
  scope: WikiWriteScope,
  wikiId: string,
): { allowed: true } | { allowed: false; reason: WikiWriteDenial };
```

Resolution rules. The **workspace rule** is: the workspace has a `wikiId` (project or not) → `locked` to it; otherwise `open` with `excludedWikiIds` = every wiki id bound to any workspace.

| Input                                                                                        | Scope                                     |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `workspaceId` given (server-set `configurable.workspaceId`)                                  | workspace rule; `unresolved` if not found |
| `workspace-chat` thread                                                                      | `getWorkspaceByThreadId` → workspace rule |
| `task` thread whose task has a `workspaceId`                                                 | workspace rule for that workspace         |
| `task` thread for a global task; `chat`; `wiki`                                              | `open`, no exclusions                     |
| Thread meta not found; workspace-chat thread with no workspace; task not found; unknown type | `unresolved`                              |

- `workspaceId` wins when present. Workspace chat, task runs and headless turns set it on the run config; the workspace summarizer only sets `thread_id` (the workspace's own thread), which resolves through the thread row.
- Workspace-scoped task runs execute in their **own `task` thread**, not the workspace-chat thread, so the `task` row is resolved through `getTaskByThreadId` to find the task's workspace. Treating every `task` thread as global would leave those runs unrestricted.

- `checkWikiWrite` behavior:
  - `locked` denies any other id with reason `locked`.
  - `open` denies excluded ids with reason `owned-by-another-workspace`.
  - `unresolved` denies everything with reason `unresolved`.
- New store query: `WorkspaceStore.listBoundWikiIds(): string[]` (`SELECT DISTINCT wiki_id FROM workspaces WHERE wiki_id IS NOT NULL`). A shared wiki bound to several workspaces locks all of them to it, which is intended.

**Enforcement point: `api/src/services/wiki-write.ts`**

- `createWikiPage` / `updateWikiPage` replace `allowedWikiId?: string` with `scope?: WikiWriteScope`.
  - When `scope` is omitted, writes are unrestricted. Only `bin/eval.ts` and unit tests omit it.
- The check runs where the `allowedWikiId` check runs today: after `reg.load` (unknown wikis still report `unknown_wiki`) and before the archived check.
- The `wiki_forbidden` result changes to `{ status: 'wiki_forbidden'; wikiId; reason: WikiWriteDenial; allowedWikiId?: string }`. `allowedWikiId` is set only for `locked`.
- `wiki-add-cross-link.tool.ts` and `wiki-rebaseline-source.tool.ts` replace their inline `allowedWikiId` comparison with `checkWikiWrite`.

**Agent-facing messages: `api/src/agents/tools/wiki-write-guard.ts`**

- `locked`: the existing `wikiWriteForbiddenMessage` text, unchanged.
- `owned-by-another-workspace`: `Wiki "<id>" belongs to another workspace and can't be written from here. Choose a different wiki (wiki_locate can help), or ask the user where this should go.`
- `unresolved`: `Wiki writes are unavailable because this conversation's workspace could not be determined.`

**Scope is resolved at call time, not at agent build time**

- Write tools read `config.configurable.thread_id` (and `workspaceId`, when set) and call `resolveWikiWriteScope` on every invocation.
  - With no `thread_id` (evals, unit tests), they pass no scope, which means unrestricted.
  - A `thread_id` that resolves to nothing yields `unresolved`, which fails closed.
- Why: `getWorkspaceChatAgent` caches agents per workspace. An unbound workspace's exclusions depend on _other_ workspaces' bindings, so values captured at build time would go stale.
- Remove the captured parameter and its plumbing:
  - `buildWikiWriteTools(allowedWikiId)` → `buildWikiWriteTools()`.
  - The `allowedWikiId` params of the `makeWiki*Tool` factories.
  - `getWorkspaceChatAgent`'s / `buildWorkspaceChatAgent`'s `allowedWikiId` param.
  - `resolveAllowedWikiId` and its call sites in `workspace-chat-stream-handler.ts`, `task-execution.ts`, `resolve-thread-agent.ts`, and `workspace-chat.route.ts`.

**AfterAgent: `api/src/agents/after-agent.ts`**

- `runAfterAgentPipeline` resolves `scope = resolveWikiWriteScope({ threadId, workspaceId }, …)` **before** the summarize and classify LLM calls. `afterAgentMiddleware` passes `runtime.configurable.workspaceId`. `RunAfterAgentPipelineParams` gains `workspaceId?` and a test-only `threadStore?`, matching the existing `store?` / `registry?` escape hatches.
- `unresolved` → warn log, `setAfterAgentDone(threadId, 'no-op')`, return. No LLM calls are made.
- Candidate domains passed to `buildExtractPrompt` are `registry.list()` filtered by `checkWikiWrite(scope, d.id).allowed`.
  - A `locked` scope offers exactly one domain.
  - If filtering leaves no domains, the result is `no-op`. This matches today's empty-registry branch.
- The existing unknown-domain check runs against the **filtered** list, so an out-of-scope id becomes a `no-op` before `saveRawSource` touches that domain. `createWikiPage` / `updateWikiPage` also receive `scope`, as a second line of defense.

**Prompt copy**

- `buildWorkspaceContextBlock` (`chat-agent.ts:454`) changes its bound-wiki line to: `Bound wiki domain: "<domain>" — this workspace's memory lives here. Wiki writes from this workspace can only go to this domain; you can still read and search other domains.`

### 3. Deleting a wiki domain

Persistent wikis created from the form need a way out, and E2E tests need to clean up after themselves.

- New route: `DELETE /api/v1/wiki/domains/:id` (API only, no UI button in this change).
  - Unknown id → 404.
  - Id is bound to any workspace (`listBoundWikiIds()`), which includes every project wiki → 409 `Wiki "<id>" is bound to a workspace; unbind it first.`
  - Otherwise `registry.destroy(id)` → 200 `{ deleted: true }`.
  - Registry unavailable → 503, matching `GET /domains`.

---

## Error handling summary

| Failure                                                   | Result                                                                |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `newWiki` together with `wikiId`                          | 400, no side effects                                                  |
| Empty wiki slug                                           | 400, no side effects                                                  |
| Wiki id already registered (pre-check)                    | 409, no side effects                                                  |
| Wiki id registered by a concurrent request (`reg.create`) | 409; directory rolled back                                            |
| Other `reg.create` failure                                | 500; directory rolled back; no workspace row                          |
| `store.createWorkspace` throws                            | 500; created wiki destroyed + directory removed (best-effort, logged) |
| Write outside scope                                       | `wiki_forbidden` + reason-specific agent message                      |
| AfterAgent cannot resolve scope                           | `no-op`, warn log, no LLM calls, never throws                         |

---

## Testing

Test tags follow the root `AGENTS.md` conventions. Tests sit next to the files they cover.

### Evals (written failing first, per the EDD rules)

- **`suites/create-workspace-project.yaml` → `cwp-008-workspace-creates-new-dedicated-wiki`** (`tool-sequence`). After a confirmation turn in which the user asked for a workspace "with its own wiki called Image Archive Notes", `create_workspace` is called with `newWikiName: "Image Archive Notes"` and no `wikiId`. _Purpose:_ the agent-driven flow must reach the same "known domain" outcome as the UI, or chat-created workspaces stay unscoped.
- **`suites/wiki-write.yaml` → new scenario for the `owned-by-another-workspace` rejection** (`tool-sequence`).
  - Setup: seed a rejected `wiki_create_page` against `video-streaming` from an unbound workspace, with the new message.
  - Asserts: the next call is **not** `wiki_create_page` with `wikiId: video-streaming`. `responseRubric` checks that the reply either asks the user or picks a different domain.
  - _Purpose:_ a rejection only helps if the agent stops retrying the forbidden wiki.
- **`suites/after-agent.yaml` → new extract scenario** (`structured`).
  - Setup: the candidate list holds only `image-archive`; the turn discusses NodeJS streaming internals that would topically fit a video-streaming wiki.
  - Asserts: `domainId` equals `image-archive`.
  - _Purpose:_ the code filter enforces the scope, but the extract prompt must not fight a one-candidate list, or turns silently become `no-op`s.

### Developer tests

- **`api/src/routes/v1/wiki.route.test.ts`** `[orchestration]`: delete succeeds and the domain disappears from `GET /domains`; 404 for an unknown id; 409 for a bound domain.

- **`api/src/services/wiki-write-scope.test.ts`** `[unit]`:
  - one test per row of the resolution table
  - `checkWikiWrite` for each scope kind, including `unresolved` denying every id
  - an unbound workspace does not exclude its _own_ (null) binding and does exclude another workspace's binding
- **`api/src/services/wiki-write.test.ts`** `[unit]`:
  - `wiki_forbidden` with each reason, for both create and update
  - an allowed write to an archived project domain still returns `wiki_archived`
  - an omitted scope stays unrestricted
- **`api/src/routes/v1/workspaces.handlers.test.ts`** `[orchestration]`, real temp `WorkspaceStore` and `WikiRegistry`:
  - `newWiki` creates a registered, non-ephemeral domain (no `type: ephemeral` in `index.md`) and binds its id
  - 409 on collision leaves no directory on disk
  - 400 on `newWiki` + `wikiId`, and on an empty slug, both with no directory created
  - `reg.create` failure removes the directory and creates no row
  - `store.createWorkspace` failure destroys the new wiki and removes the directory
  - **Deleting a workspace whose wiki was created this way leaves the domain registered and its pages intact.**
- **Write-tool call-time scope** `[orchestration]`, in `wiki-create-page.tool.test.ts`:
  - build the tool, then bind `video-streaming` to another workspace, then invoke the tool from an unbound workspace thread → forbidden with `owned-by-another-workspace`
  - a bound non-project workspace thread writing elsewhere → `locked`
  - a workspace-scoped task's own `task` thread → that workspace's lock
  - an unknown thread id → `unresolved`
- **`api/src/agents/after-agent.test.ts`** `[orchestration]`:
  - locked scope: the extract prompt lists only the bound domain and the page lands there
  - a stub LLM returning an out-of-scope domain id: no page is written anywhere, and the result is `no-op`
  - unresolved thread: no write, `no-op`, and the stub LLM is never invoked
- **`api/src/agents/tools/create-workspace.tool.test.ts`** `[orchestration]`:
  - `newWikiName` creates and binds a new domain
  - `newWikiName` + `wikiId` returns the pick-one error and creates nothing
  - a colliding name returns the 409 message
- **UI Jest** in `ui/test/` (where UI tests live): a new `new-wiki-name-field.test.tsx`, plus additions to `workspace-create-form.test.tsx`:
  - `newWikiNameError` `[unit]`: empty slug, collision, and a valid name
  - selecting "Create new wiki…" reveals the Wiki name input
  - the input follows the workspace name until edited, then stops following
  - a colliding or empty name shows the inline error and disables submit
  - submit sends `newWiki` and no `wikiId`

### E2E: `e2e/tests/003-Workspace.spec.ts` (CI-safe, no `@llm`)

- `@user-workflow`: create a workspace with **Create new wiki…** and a custom name, then check that the wiki appears in the wiki domain list.
- `@user-workflow`: delete that workspace, then check that the wiki is still listed.
- `@user-workflow`: choose a name that collides with an existing domain, then check that the inline error shows and submit is disabled.
- Tests remove any wiki domains they create through `DELETE /api/v1/wiki/domains/:id`, even on failure.

---

## Documentation

- `TODO_LIST.md`: #202 is not listed, so no change is needed.
- Update the #79 design doc's status line to note that its per-project write restriction is superseded by this scope model. Keep the rest of the doc as history.
