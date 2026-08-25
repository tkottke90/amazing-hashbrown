# AI-Powered Plan Generation — Design

**Date:** 2026-08-25
**Status:** Draft
**Related:** [Issue #76](https://github.com/tkottke90/amazing-hashbrown/issues/76)

---

## Goal

Wire up the task drawer's existing sparkle button (`ui/src/components/task-drawer.tsx`) so clicking it generates a first-draft list of plan steps from the task's title/description (and, when the task is workspace-bound, workspace context) and appends them to the task's plan.

---

## Problem

The task drawer already has a plan field where users manually add `{ step, done }` entries, and a `Sparkles` icon button is rendered next to it (`task-drawer.tsx`, inside the `data-testid="task-plan"` block) — but it has no `onClick` handler. Users get no assistance drafting a plan even when the title/description (and workspace context, when present) contain enough information for an agent to produce a reasonable starting point.

---

## Non-goals

- Multi-turn refinement of a generated plan (e.g. "regenerate" or a chat-style back-and-forth to adjust steps) — this is a single-shot generation per click.
- Editing or reordering existing steps as part of generation — generated steps are strictly appended; existing steps are never touched.
- Retry-on-parse-failure — a malformed model response is treated as a generation failure (see [Error handling](#error-handling)).
- Full directory contents or file content in the generation prompt — only a shallow file listing (see [Path A](#path-a--workspace_id-present)).

---

## Design

### API endpoints & routing

Two new routes in `api/src/routes/v1/tasks.route.ts`, both thin handlers delegating to `HandlerResult`-returning functions (same shape as the existing `GET /:id`, `PATCH /:id`, etc.):

- `POST /api/v1/tasks/generate-plan` — body `{ title: string, description?: string, workspace_id?: string }`. Registered **before** the `/:id` routes (same reason `/queue` is registered first today) so it isn't swallowed as an `:id` param.
- `POST /api/v1/tasks/:id/generate-plan` — looks the task up via `WorkspaceStore`, then resolves `title`/`description`/`workspaceId` from the stored record.

Both return `200` with `PlanStep[]` (`{ step: string, done: boolean }[]`) on success, or a typed error on failure. Both call the same shared core function, so generation logic exists once:

```ts
async function generatePlan(input: {
  title: string;
  description: string | null;
  workspaceId: string | null;
}): Promise<PlanStep[]>;
```

### Path A — `workspace_id` present

Applies whether the task is saved or unsaved — the branch is on `workspace_id`, not on save state.

1. Load the workspace record (`workspace-store.ts`).
2. If `workspace.wikiId` is set: `getWikiRegistry()` → `registry.load(wikiId)` → `wiki.semanticSearch(title + ' ' + description, { limit: 5 })` → `wiki.readPage(path)` for each hit, concatenated into a context block. This reuses the exact mechanism the `wiki_search` tool already uses. A missing registry, missing wiki, or empty result set degrades gracefully — the block is simply omitted, generation still proceeds. If `wikiId` is unset (plain, non-project workspace), this step is skipped entirely.
3. Fetch a shallow file listing by calling the existing `getFileTree(workspaceId, { location, git })` (already backing `GET /api/v1/workspaces/:id/files`) in-process, then truncate to top-level entries only (depth 1: immediate children of the workspace root, directories not expanded further) before formatting into the prompt. Same graceful-degradation rule as step 2 on any failure (missing/unreadable location, git error) — the block is omitted.
4. Build the prompt per the issue's shape: title, description, then the workspace context block (name, goal, description), the wiki block, and the shallow file-listing block, followed by the fixed instruction to return only a JSON array of `{ step, done }`.
5. Single `model.invoke(prompt)` call via `createProvider(...)` (the same provider-factory function `generateTitleHandler` uses — model comes from configured provider, never hardcoded), wrapped in the same observability-trace pattern (`startTrace` / `ObservabilityCallbackHandler` / manual `handleChainEnd` + `endTrace`, since a bare `invoke()` doesn't fire it automatically).

### Path B — no `workspace_id`

Build a small, purpose-specific agent via the same `createAgent()` primitive the chat agent uses (`api/src/agents/chat-agent.ts`), scoped narrowly:

- `tools: [wikiSearchTool, wikiReadPageTool]` — the agent decides for itself whether/what to look up, based on the title and description.
- A plan-generation-specific system prompt (distinct from `buildSystemPrompt(getAgentInstructions())`) instructing it to research as needed and finish with a JSON array only.
- **No checkpointer** — this is a single, stateless turn, not a persisted conversation, so no `SqliteSaver`/thread id is created.

Invoked once with a single human message containing the title/description and the same "return ONLY a JSON array" instruction as Path A.

### Response parsing & validation

Both paths funnel their final text through one shared validator:

```ts
function parsePlanSteps(raw: string): PlanStep[] | null;
```

It trims/strips surrounding prose or code fences defensively (mirroring how `generateTitleHandler` trims and strips quotes from its output), `JSON.parse`s the result, and checks it's an array of objects each shaped `{ step: string, done: boolean }`. Any parse error or shape mismatch returns `null`, which both handlers treat as a generation failure — **no retry**.

### Frontend wiring (`task-drawer.tsx`)

- New signals `generatingPlan` and `generatePlanError`, mirroring the existing `trackerResolving`/`trackerResolveError` pair.
- New service functions in `ui/src/services/tasks-api.ts` (`generatePlan(taskId)`, `generatePlanForNewTask({ title, description, workspaceId })`) and corresponding hook functions in `ui/src/hooks/use-tasks.ts`, following the existing two-layer service/hook split.
- Sparkle button:
  - **Disabled** when the title field is empty/whitespace (tooltip: "Add a title before generating a plan") or while `generatingPlan.value` is true.
  - **On click**: set `generatingPlan.value = true`, swap the `Sparkles` icon for a spinning `Loader2` (existing spinner convention), call `generatePlan(task.id)` if the task is already saved, otherwise `generatePlanForNewTask({...})` using the in-drawer title/description/`workspaceId.value`.
  - **On success**: append the returned steps to `planSteps.value` (existing steps first, generated steps after — never replacing or reordering). If the task is already saved, immediately call the existing `updatePlan(task.id, planSteps.value)` to persist, mirroring what `toggleStep` already does today.
  - **On failure**: set `generatePlanError.value` to a short message, render it inline under the plan field (`text-xs text-destructive`, matching the existing error-text convention elsewhere in this component), and leave `planSteps.value` untouched.

---

## Error handling

| Case                                                          | Behavior                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No title (empty/whitespace)                                     | Sparkle button disabled, tooltip: "Add a title before generating a plan"           |
| Workspace record not found (stale `workspace_id`)                | Path A context-fetch steps are skipped as if no workspace was bound; generation proceeds with just title/description |
| Wiki registry/domain unavailable or empty search results         | Wiki context block omitted; generation proceeds                                    |
| File-listing fetch fails (missing/unreadable location, git error) | File-listing block omitted; generation proceeds                                    |
| Model/provider error (network, API failure)                      | Handler returns a failure; inline error shown; existing plan untouched             |
| Model response isn't valid `{step, done}[]` JSON                 | Treated as a generation failure (no retry); inline error shown; existing plan untouched |
| Generation succeeds while another generation is already in flight | Sparkle button is disabled during generation, so this can't be triggered from the UI |

---

## Testing

### Backend (Mocha/chai, co-located `.test.ts`, following `tasks.handlers.test.ts` conventions)

- Handler tests call the pure handler functions directly against an in-memory/tmp sqlite `WorkspaceStore`, with `FakeListChatModel` / a custom `BaseChatModel` subclass standing in for the provider (per the repo's "always mock external services" rule) — no real model calls, no HTTP layer.
- Coverage: happy path for both routes; Path A with a workspace that has no `wikiId`; wiki-unavailable degradation; file-listing-unavailable degradation; invalid-JSON-response failure (`parsePlanSteps` returns `null`); unsaved-task path with and without `workspace_id`.
- A `CapturingModel` (as already used for the title-generation tests) to assert the prompt actually sent includes the expected title/description/context blocks.
- New `suites/task-plan-generation.yaml` eval scenario, following the `suites/thread-titles.yaml` convention already used to regression-test prompt templates outside of unit tests.

### Frontend (existing task-drawer test conventions, if present, or manual verification)

- Sparkle button disabled when title is empty; enabled once a title is entered.
- Loading state swaps the icon and disables the button during generation.
- Success path appends to existing steps without removing/reordering them, and persists via `updatePlan` for a saved task.
- Failure path shows inline error text and leaves the plan unchanged.

### E2E (Playwright, extending the existing `task-plan-field.spec.ts` suite or a new suite alongside it)

Following the repo's mocking convention, e2e coverage stubs the `generate-plan` API response via Playwright route interception rather than invoking a real model:

| Action                                                                 | Expected outcome                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Open a new task drawer with no title, click the sparkle button           | Button is disabled; tooltip shows "Add a title before generating a plan"   |
| Enter a title, stub a successful `generate-plan` response, click sparkle | Loading state shown briefly, then the returned steps appear in the plan    |
| Add a manual step first, then generate via a stubbed success response    | Manual step remains first; generated steps are appended after it           |
| Stub a `generate-plan` failure response, click sparkle                   | Inline error shown; plan section is unchanged                              |
| Generate on an already-saved task via a stubbed success response         | Steps appear and persist after closing/reopening the drawer (via `updatePlan`) |
