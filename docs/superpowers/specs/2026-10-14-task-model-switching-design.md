# Per-Task Model Switching — Design

**Date:** 2026-10-14
**Status:** Draft

---

## Goal

Task execution always resolves to `env.defaultProvider`, resolved to a concrete model up front at run time (`task-execution.ts:298-301`, `resolveTurnModel`). No task stores its own provider/model, and there is no update path — `Task`, `NewTaskInput`, and `PatchTaskInput` (`workspace-store.ts:122-175`, `231-269`) have no such field. This means:

- A task that consistently fails against the configured default model has no way to be moved to a model that handles it better, short of changing the system-wide default (which affects every task).
- A task whose default provider is a paid API can become permanently unrunnable once funds run out, with no way to redirect it to a different (e.g. local/free) provider without the same system-wide change.

This design lets a user pin an individual task to a specific provider/model from the Task Details drawer, while the task is not actively running, reusing the provider/model picker and PATCH infrastructure that already exist for other task fields.

---

## Non-goals

- **Sub-agent/role tasks are untouched.** Tasks spawned via `spawn-sub-agent.tool.ts` already get their provider/model from a separate `RoleConfig` (`spawn-sub-agent.tool.ts:76`, consumed in `chat-agent.ts:816-821`). This design only changes the ordinary top-level task run path in `task-execution.ts`; `RoleConfig` resolution is not touched.
- **No billing/credits system.** "Funds run dry" is the motivating scenario, not a feature to build — this design only makes the model swappable, it does not track spend or warn about balances.
- **No backfill of historical tasks.** Existing rows get `NULL` provider/model after migration and are treated identically to a stale/invalid snapshot at run time (same fallback path, see Section 3) — no migration-time guess at what they "would have" used.
- **No change to how a task is triggered or resumed.** Switching a task's model only changes what it runs with _next time_ (including its next scheduled/cron firing, since it's the same row) — it does not itself retry, resume, or restart anything.

---

## Design

### 1. Data model & migration

New migration (version 41, following the versioned DDL block at `workspace-store.ts:536-560`, same pattern used for `threads.provider`/`threads.model` in migrations 13-16, `thread-store.ts:220-232`):

```sql
ALTER TABLE tasks ADD COLUMN provider TEXT NULL;
ALTER TABLE tasks ADD COLUMN model TEXT NULL;
```

- `Task` (`workspace-store.ts:122-175`) gains `provider: string | null` and `model: string | null`; `mapTask()` (line 453) passes both straight through.
- `NewTaskInput` (lines 231-250): both fields are populated from `env.defaultProvider` at creation time — every _new_ task gets an explicit snapshot, never null.
- `PatchTaskInput` (lines 252-269) gains optional `provider?: string` and `model?: string`.
- Existing rows are left `NULL` by the migration — no backfill.

### 2. API layer

Rides the existing `PATCH /api/v1/tasks/:id` (`tasks.route.ts:113-132` → `patchTaskHandler`, `tasks.handlers.ts:189-250`); no new route.

`patchTaskHandler` validates, in order, before calling `store.patchTask`:

1. **Paired fields.** If exactly one of `provider`/`model` is present in the patch body, reject with 400 — a dangling half-pair is meaningless.
2. **Status guard.** If `current.status === 'running'`, reject with the same 409 shape as the existing "can't reassign a running task" guard at lines 203-212. Every other status — `pending`, `scheduled`, `ready`, `waiting_on_user`, `blocked` — is allowed; the terminal statuses `done`/`failed`/`cancelled` are **also rejected** (409, same shape), since there is nothing left to run with a new model.
3. **Known-pair check.** The submitted `provider`/`model` pair must appear in the current `env.providers`-backed list (the same data `GET /api/v1/providers`, `providers.route.ts:17-56`, serves). An unrecognized pair is rejected with 400 before it ever reaches the store — bad data is never persisted on the chance it resolves later.

### 3. Run-time resolution

In `task-execution.ts`, the model-resolution call at lines 298-301 changes from an unconditional `resolveTurnModel(env.defaultProvider)` to:

```
task.provider && task.model
  ? resolveTurnModel({ provider: task.provider, model: task.model })
  : resolveTurnModel(env.defaultProvider)
```

If `task.provider`/`task.model` are set but no longer resolve to a real, currently-configured provider/model (provider removed, API key pulled, model decommissioned since the snapshot was taken), resolution falls back to `env.defaultProvider` the same way a `NULL` row does, and logs a warning so the discrepancy is visible without blocking the run. Legacy `NULL` rows and stale snapshots are deliberately treated the same — both just mean "nothing valid pinned, use the system default."

### 4. UI — Task Details drawer

- `TaskDrawer`/`TaskForm` (`ui/src/components/task-drawer.tsx`) gains a provider/model picker next to the existing status `<select>` (line ~1074-1091), reusing `useProviderModelPicker` (`ui/src/components/provider-model-picker.tsx`), the same hook `chat-input.tsx:415` already uses — no new picker component.
- The picker is pre-populated from the task's current `provider`/`model`.
- **Gating:** disabled whenever `liveStatus.value === 'running'` or is one of the terminal statuses (`done`/`failed`/`cancelled`) — the same `liveStatus` signal already gating the Pause/Take-over/Cancel/Resume buttons (lines 843-944), just one more consumer of it.
- **Save behavior:** immediate on selection, firing the PATCH right away — matches the status field's existing save-on-change pattern, no separate Save button.
- **Rejection handling:** if the PATCH is rejected (bad pair, or a race where the task started running between page-load and selection), show an inline error next to the picker and revert the displayed selection to the last known-good value from the server response.

### 5. Error handling summary

| Case                                                          | Behavior                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Patch has `provider` without `model` (or vice versa)          | 400, rejected before touching the store                           |
| Patch submitted while `status === 'running'`                  | 409, same shape as existing reassignment guard                    |
| Patch submitted while `status` is `done`/`failed`/`cancelled` | 409, new guard alongside the running guard                        |
| `provider`/`model` pair not in current `env.providers` list   | 400, rejected before persisting                                   |
| Snapshotted pair no longer resolvable at run time             | Falls back to `env.defaultProvider`, warning logged, run proceeds |
| Legacy task with `NULL` provider/model                        | Same fallback as above, no distinction from a stale snapshot      |

---

## Testing

Developer tests (Mocha + Chai for `api/`, Jest for `ui/`), adjacent `*.test.ts`/`*.test.tsx` files per this repo's convention. No `supertest`/Express-layer testing — handlers are tested directly.

- `workspace-store.test.ts` — unit: migration adds `provider`/`model` columns; `NewTaskInput` snapshots `env.defaultProvider` at creation; `patchTask` persists both fields together.
- `tasks.handlers.test.ts` — unit: calls `patchTaskHandler` directly with mocked `req`/`res`, spying on `store.patchTask`. Covers each rejection path (partial pair, running, terminal status, unknown pair) and confirms a valid patch on an idle/blocked/waiting task calls `store.patchTask` with the right arguments.
- `task-execution.test.ts` — unit: resolution prefers `task.provider`/`task.model` when both set and valid; falls back to `env.defaultProvider` when either is null; falls back (with warning logged) when the snapshotted pair is no longer in `env.providers`.
- `task-drawer.test.tsx` (Jest) — unit: picker disabled when `liveStatus` is `running` or a terminal status, enabled otherwise; selecting a new model fires the PATCH; a rejected PATCH reverts the displayed value and shows the inline error.
- Playwright E2E (`@user-workflow`): user opens an idle task's drawer, switches its model, drawer reflects the new value after reload; a second scenario confirms the picker is disabled/non-interactive on a running task.

### Eval requirement (EDD) — not applicable

This change does not alter LLM-facing behavior (no prompt, tool, or model-output change) — it only changes which model a task's existing behavior runs against. Root `AGENTS.md`'s Evaluation-Driven Development rules apply to new/changed LLM-facing behavior and bug fixes in LLM output; neither applies here, so no new eval scenario is required.
