# Webhook Task Trigger — Design

**Date:** 2026-08-25
**Status:** Draft
**Related:** [Issue #80](https://github.com/tkottke90/amazing-hashbrown/issues/80)

---

## Goal

Let an external service (CI pipeline, GitHub Action, monitoring alert, Zapier flow, etc.) enqueue a specific task with a single unauthenticated `POST` to a unique, opaque URL — no session, no API key. Each task with `trigger_type = 'webhook'` gets its own token-bearing URL, shown in the task drawer with a copy button and a way to rotate it.

---

## Problem

`TriggerType` already includes `'webhook'` (`api/src/services/workspace-store.ts:78`) and the concept is threaded through `Task`/`NewTaskInput`/`PatchTaskInput`, but nothing acts on it: there is no route that accepts a webhook call, and the task drawer (`ui/src/components/task-drawer.tsx`) has no trigger-type selector at all — `trigger_type` is only ever displayed read-only, in the inbox table row. Selecting or configuring a webhook trigger is new ground on both ends.

---

## Non-goals

- **Cron trigger UI** (`cron_once`/`cron_repeat`). The type selector added here exposes only **Manual** and **Webhook** — cron stays hidden until it gets its own feature work (tracked separately, e.g. [#72](https://github.com/tkottke90/amazing-hashbrown/issues/72)).
- **Any auth beyond the token itself** — confirmed out of scope by the issue's own "Design Needs: None."
- **Using the webhook request body for anything.** It's accepted (global `express.json()` already parses it) but never read. The issue calls this out explicitly as future context-passing groundwork, not something to build now.
- **A "requeue on completion" / self-perpetuating task loop.** This is a real pattern the webhook trigger enables in combination with other work, but it depends on task-agent execution actually existing, which it doesn't yet — see [Future work](#future-work).
- **Wiring up real-time `task_queue_update` delivery.** `registerQueueBroadcast()` (`task-scheduler.ts`) has no caller anywhere and no UI consumer exists — this webhook trigger follows the same `getTaskScheduler().wake()` convention every other enqueue path already uses, and leaves that pre-existing, unrelated gap alone.

---

## Design

### Token ownership

The server is the sole source of truth for `trigger_config.webhookToken` — a client can never set it directly, even via the generic `PATCH /api/v1/tasks/:id`, which today writes whatever `trigger_config` it's given with no field-level validation. Rule, applied identically on task creation and on patch:

- If the resulting `triggerType` is `'webhook'` and there's no existing token, mint one with `crypto.randomUUID()` (matching this codebase's existing id-generation primitive, e.g. `workspace-store.ts:699`).
- A new `regenerateWebhookToken?: boolean` flag on the patch body forces a fresh token, discarding the old one. It's a no-op if the resulting `triggerType` isn't `'webhook'`.
- Any client-supplied `triggerConfig.webhookToken` is always discarded and replaced by the server-resolved value.

This logic lives in a small shared helper (used by both `createTaskHandler` and `patchTaskHandler` in `api/src/routes/v1/tasks.handlers.ts`, since a brand-new task can be created directly with `triggerType: 'webhook'`, not just edited into it later):

```ts
function resolveTriggerConfig(
  current: { triggerType: TriggerType; triggerConfig: unknown } | null,
  incoming: { triggerType?: TriggerType; triggerConfig?: unknown; regenerateWebhookToken?: boolean },
): unknown {
  const resultingType = incoming.triggerType ?? current?.triggerType ?? 'manual';
  if (resultingType !== 'webhook') return incoming.triggerConfig;

  const existingToken = (current?.triggerConfig as { webhookToken?: string } | null)?.webhookToken;
  const webhookToken =
    incoming.regenerateWebhookToken || !existingToken ? randomUUID() : existingToken;
  return { webhookToken };
}
```

`patchTaskHandler` (`tasks.handlers.ts:57-74`) changes to fetch the current task first (it needs to for the existing/new-token decision anyway), compute the resolved `triggerConfig`, and pass that — not the client's raw one — into `store.patchTask`. `regenerateWebhookToken` is stripped before the call, since `PatchTaskInput` (`workspace-store.ts:119-133`) has no such field. `createTaskHandler` (`tasks.handlers.ts:48-55`) gets the same treatment with `current = null`.

No schema change: `trigger_config` stays the existing JSON `TEXT` column (`workspace-store.ts:325-348`).

### Backend route

New `api/src/routes/v1/triggers.route.ts` + `triggers.handlers.ts`, following the thin-router-delegates-to-pure-handler split every other `*.route.ts`/`*.handlers.ts` pair in this codebase uses. Mounted as its own top-level router in `api/src/routes/v1/index.ts` (`v1Router.use('/triggers', triggersRouter)`) — the URL doesn't nest under `/tasks`, and file-per-router mounting here is always explicit, one line each (`v1/index.ts:17-30`).

`POST /api/v1/triggers/webhook/:token`:

1. `store.findTaskByWebhookToken(token)` — new `WorkspaceStore` method (see below). No match → `404`.
2. Reuse the exact "already active" guard already used by `patchTaskHandler`'s R14 path (`tasks.handlers.ts:69`): `store.listQueue().some(e => e.taskId === task.id)`. `listQueue()` (`workspace-store.ts:806-813`) already scopes to `status IN ('pending','running','paused')`, so this single check covers both "queued" and "running." Match → `409` with a message naming the task as already active.
3. Otherwise: `store.enqueueTask(task.id)`; mirror `status` to `ready` if it isn't already (same as `enqueueTaskHandler`, `tasks.handlers.ts:104-106`); call `getTaskScheduler().wake()` (same pattern as every other enqueue-adjacent route).
4. Return `201` with the queue entry — same response shape `POST /:id/enqueue` returns today.

A local `conflict()` helper (`{ ok: false, status: 409, error }`) is added to `triggers.handlers.ts`, following the same per-file `ok`/`notFound`/`badRequest` pattern already duplicated across `tasks.handlers.ts`, `workspaces.handlers.ts`, etc.

### Store method

```ts
findTaskByWebhookToken(token: string): Task | null {
  const row = this.db
    .prepare(
      `SELECT * FROM tasks
       WHERE trigger_type = 'webhook'
         AND JSON_EXTRACT(trigger_config, '$.webhookToken') = ?
       LIMIT 1`,
    )
    .get(token) as RawTaskRow | undefined;
  return row ? mapTask(row) : null;
}
```

No new index — per the issue's own note, `JSON_EXTRACT` is fine at current scale; a dedicated indexed column is a documented future option if webhook volume ever becomes a concern.

### Frontend UI

In `TaskForm` (`ui/src/components/task-drawer.tsx`), a new "Trigger" field group, placed alongside the existing Assigned-to/Workspace selects (same wrapper/label/select classes as e.g. `task-drawer.tsx:472-486`):

- `triggerType` signal, seeded from `task?.triggerType ?? 'manual'`. Select with exactly two options: **Manual**, **Webhook**.
- When `Webhook` is selected on an **existing, saved task** (`!isNew`): a read-only monospace field showing `${window.location.origin}/api/v1/triggers/webhook/${webhookToken}`, a **Copy** button (`navigator.clipboard.writeText`, `Copy`/`Check` icons from `lucide-preact` — this codebase's existing icon set — swapping icon briefly on click as the only feedback; no such copy-to-clipboard pattern exists yet in this UI, so this establishes it), and a **Regenerate URL** button.
- **Regenerate URL** uses `window.confirm('This will invalidate the current URL. Continue?')` before calling `patchTask(task.id, { regenerateWebhookToken: true })` — the same native-`confirm()` pattern this codebase already uses for its other destructive actions (`ui/src/pages/workspaces/[id].tsx:295,301`, `ui/src/hooks/use-workspace-files.ts:140`), not a new dialog component. This is its own click handler, independent of `handleSave` — it does **not** submit the form or close the drawer; on confirm, only the local `webhookToken` state updates from the patch response, so the field shows the new URL immediately while the drawer stays open.
- When `Webhook` is selected on a **new, unsaved task** (`isNew`): the URL field is replaced by a note ("Webhook URL is generated once the task is saved"), since no token exists yet. **Behavior note:** `handleSave` already closes the drawer immediately after every save, for both create and edit (`task-drawer.tsx:295-296`) — this design doesn't change that. So a just-created webhook task doesn't reveal its URL in the same sitting; the user reopens the task (from the inbox/kanban list) to see it, exactly like every other field that's only meaningful after save (e.g. Status, which is already `!isNew`-gated at `task-drawer.tsx:499`). This satisfies the issue's "shown for both new and existing tasks" as "once a task exists with `trigger_type = 'webhook'`, opening its drawer shows the URL" — not as "visible without ever leaving the create form."
- `patchTask`'s UI-side type (`ui/src/services/tasks-api.ts:96-98`) gains `regenerateWebhookToken?: boolean` alongside its existing `Partial<CreateTaskInput & { status }>` — additive, no existing call sites affected.

---

## Error handling

| Case | Behavior |
| --- | --- |
| Token doesn't match any task | `404`, generic message — no hint about whether a task ever existed for that token |
| Task's queue entry status is `pending`, `running`, or `paused` | `409` with a message identifying the task as already active |
| `regenerateWebhookToken: true` sent for a non-webhook (or becoming non-webhook) task | No-op — ignored, not an error |
| Client sends `triggerConfig.webhookToken` directly (create or patch) | Silently discarded; server-resolved value always wins |
| Webhook request body present | Parsed by the existing global `express.json()`, never read |

---

## Testing

### Backend (Mocha, co-located `.test.ts`, following `tasks.handlers.test.ts` conventions — real throwaway-SQLite-backed `WorkspaceStore`, no HTTP layer)

- `triggers.handlers.test.ts`: unknown token → `404`; task already queued → `409`; task already running → `409`; happy path → `201`, a `task_queue` row exists for the task, `task.status` becomes `ready`; request body present but arbitrary → still succeeds, ignored.
- Additions to `tasks.handlers.test.ts`: creating a task with `triggerType: 'webhook'` generates a token; patching an existing task's `triggerType` to `'webhook'` generates a token; patching with `regenerateWebhookToken: true` replaces an existing token with a new one; patching with `regenerateWebhookToken: true` on a non-webhook task is a no-op; a client-supplied `triggerConfig.webhookToken` is ignored on both create and patch.

### Frontend / E2E

No component-level test framework is exercised for `task-drawer.tsx` beyond the existing Playwright e2e coverage. Extend the existing **Inbox & Task Management** suite (`e2e/tests/inbox-tasks.spec.ts`, id `17`, `suiteAnnotations`/`TestSuite` pattern) rather than adding a new suite — this is an incremental addition to a drawer already covered there, not a new page or major surface:

| Action | Expected outcome |
| --- | --- |
| Open a task's drawer, select "Webhook" as the trigger type, save | Reopening the task shows a read-only URL field and a Regenerate URL button |
| Click the Copy button | Clipboard receives the full URL; button shows brief confirmation |
| Click Regenerate URL and confirm the prompt | URL field updates to a new token; the old token no longer resolves (verified via a direct API call in the same test, since the UI has no way to show a 404 sending an old link) |
| Click Regenerate URL and cancel the prompt | URL is unchanged |
| Select "Webhook" on a brand-new, unsaved task | Note about the URL appearing after save is shown instead of a URL field |

---

## Future work

- **[#87](https://github.com/tkottke90/amazing-hashbrown/issues/87)** wires actual agent execution into the scheduler — today `tick()` marks a dequeued task `running` and stops (explicit `TODO` in `task-scheduler.ts:115-118`). Until this lands, a webhook-enqueued task runs no differently from any other enqueued task: it sits at `running` with nothing acting on it.
- Once #87 exists, its continuity model is the project **wiki**, not a chat thread — the agent commits findings back to the wiki mid-run, so a task re-enqueued later (by webhook or otherwise) picks up prior context via `wiki.orient()`. This is what would make a "trigger an automation → automation calls back the webhook → task continues" loop actually carry state, with no context-passing needed in the webhook body itself.
- **[#72](https://github.com/tkottke90/amazing-hashbrown/issues/72)** (cron triggers) already anticipates a closely related pattern — `cron_repeat` enqueuing its own next iteration as the final step of its own execution — which depends on #87 the same way.
