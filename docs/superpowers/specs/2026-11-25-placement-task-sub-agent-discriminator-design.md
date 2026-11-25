# Placement Review Tasks Are Not Sub-Agent Tasks — Design

**Date:** 2026-11-25
**Status:** Draft
**Related:** [ADR-0015](../../adr/0015-review-band-becomes-a-placement-review-task.md), [AfterAgent Domain Fit Gate design](2026-10-18-afteragent-domain-fit-gate-design.md), [ADR-0063](../../adr/0063-sub-agent-runs-never-trigger-afteragent.md), [`GLOSSARY.md`](../../../GLOSSARY.md) "Sub-Agent Task" and "Placement Review Task"

## Purpose

Make AfterAgent's Placement Review Tasks run as the ordinary tasks ADR-0015 says they are, so a Review Band note actually reaches the user through `ask_user` instead of failing at run start.

## Background

The Review Band of AfterAgent's Domain Fit gate creates a task titled `Wiki placement: <title>` (`createPlacementReviewTask`, `api/src/agents/after-agent.ts`). Its description tells the run to `ask_user` where the note should go. The task is created with `assignedTo: 'agent'` and `origin: 'agent'`, and no `role`.

Every such task fails immediately with `Run failed: Role "null" no longer exists.` Its run thread is empty and the user is never asked.

**Root cause.** `origin: 'agent'` has come to mean "Sub-Agent Task" in the executor. `executeTask` in `api/src/agents/task-execution.ts` branches on bare `origin === 'agent'`:

- it resolves provider/model through `env.agent.roles[runTask.role ?? '']` and throws `Role "<role>" no longer exists.` when the lookup misses (introduced in `f2acaee`, #383);
- it builds the run with `buildSubAgent` (no `ask_user`) instead of the standard builder;
- it applies the small sub-agent recursion limit;
- it excludes the run from Task Files;
- it hands completion/failure to `deliverSubAgentCompletion`, which assumes a parent thread.

`WorkspaceStore` repeats the same bare check in SQL: crash recovery (fail and notify a parent instead of escalating to the user), `dequeueNext`'s running-slot bypass, and `getRunningEntry`. The board filter in `listTasks` already uses the stricter definition (`origin = 'agent' AND parent_thread_id IS NOT NULL`), which is why placement tasks do show on the board while real sub-agent tasks do not. `GLOSSARY.md` defines a Sub-Agent Task the same stricter way (origin plus `parentThreadId`/`dispatchGroupId`/`role`, which only a real dispatch sets).

Fixing only the role lookup would not be enough: the task would then run on `buildSubAgent`, with no `ask_user`, and still could not ask the user anything.

## Decisions

1. **Discriminator.** Placement Review Tasks keep `origin: 'agent'` (provenance, per the glossary). A single `isSubAgentTask(task)` predicate defines a Sub-Agent Task as `origin === 'agent' && parentThreadId != null`. Every bare `origin === 'agent'` check meaning "is a sub-agent" is replaced by it. No new origin value.
2. **Ordinary behavior.** A task for which `isSubAgentTask` is false behaves as an ordinary task everywhere:
   - provider/model resolve from the task's pin or the system default (no Role lookup);
   - the run uses the standard builder, with `ask_user`, and the normal recursion limit;
   - a workspace-scoped task gets a Task File;
   - no `deliverSubAgentCompletion` on any outcome;
   - crash recovery retries, then escalates to the user (`waiting_on_user`) like other tasks, rather than failing and notifying a parent;
   - it occupies its scope's one-running-task slot (`dequeueNext`, `getRunningEntry`). A placement question parked on the user therefore holds its scope's slot, as any ordinary waiting task does.
3. **No UI work.** The question reaches the user through the existing HITL path (task drawer, mirrored prompt in the workspace chat). No dedicated placement card.

## Design

### Predicate

`isSubAgentTask(task: Pick<Task, 'origin' | 'parentThreadId'>): boolean` — a small pure function exported from the module that owns the `Task` type (`api/src/services/workspace-store.ts`).

For the SQL sites, export one shared fragment from the same module so TypeScript and SQL cannot drift:

```ts
export const SUB_AGENT_TASK_SQL = `(origin = 'agent' AND parent_thread_id IS NOT NULL)`;
```

Sites that need the column qualified (`tasks.origin`) compose it with a table alias or use a qualified variant exported alongside it. Choosing the exact shape is an implementation detail.

### Call sites

| Site                                                                     | Change                                                                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `task-execution.ts` role/model resolution                                | Role lookup only when `isSubAgentTask(runTask)`; otherwise the pinned-provider/default path                      |
| `task-execution.ts` builder choice (`buildSubAgent` vs `buildAgent`)     | `isSubAgentTask`                                                                                                 |
| `task-execution.ts` recursion limit                                      | `isSubAgentTask`                                                                                                 |
| `task-execution.ts` `taskFileEligible`                                   | `!isSubAgentTask(task)`                                                                                          |
| `task-execution.ts` every `deliverSubAgentCompletion` branch             | `isSubAgentTask(task)`                                                                                           |
| `WorkspaceStore` stuck-run recovery (`row.origin === 'agent'`)           | Sub-agent test via the shared definition; a placement task falls through to the ordinary escalate-to-user branch |
| `WorkspaceStore.dequeueNext` (both the `runningScopes` query and `find`) | Shared definition                                                                                                |
| `WorkspaceStore.getRunningEntry`                                         | Shared definition                                                                                                |
| `WorkspaceStore.listTasks` board filter                                  | Use the shared fragment (behavior unchanged)                                                                     |

Raw queue rows (`task_origin`, `row.origin`) must also carry whatever `parent_thread_id` information the shared SQL definition needs; the implementation joins or selects it where the row type does not already have it.

The implementation re-greps every `origin` reference in `api/src` when it lands, so no site is missed, and decides per site whether the check means "sub-agent" (replace) or something else (leave).

### Not changed

- `createPlacementReviewTask` and its description text. The task still carries `origin: 'agent'`, `assignedTo: 'agent'`, no role, no parent.
- Sub-Agent Task dispatch (`spawn-sub-agent.tool.ts`, `createSubAgentTask`) and its role validation.
- The UI.

## Out of scope

- **Already-failed placement tasks.** Failed tasks already in the Inbox and workspaces are not migrated or re-enqueued. They can be retried by hand from the task drawer or deleted. The PR description should say so.
- **Duplicate placement tasks.** The same note can produce several placement tasks across turns (no dedupe; `threadState` is in-memory). That is a separate bug and gets its own issue and design.
- **A richer placement presentation** (extracted note and candidate domain shown in a dedicated card).

## Error handling

| Case                                                                               | Behavior                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Real sub-agent task whose role was deleted after dispatch                          | Unchanged: `Role "<role>" no longer exists.`, delivered to the parent via the existing failure path |
| Placement task run crashes or the worker dies mid-run                              | Retried up to the existing limit, then escalated to the user (`waiting_on_user`)                    |
| Placement task has an `origin: 'agent'` row with `parent_thread_id` set by mistake | Treated as a sub-agent task (the definition is the single source of truth)                          |

## Testing

No eval and no e2e: no prompt text or UI behavior changes. Developer tests only, per the project's testing rules.

- **Unit** (`workspace-store.test.ts` or beside the predicate): `isSubAgentTask` is true for `origin: 'agent'` with a parent, false for `origin: 'agent'` without one (the placement task), false for `origin: 'user'`.
- **Orchestration** (`task-execution.test.ts`): a role-less, parent-less `origin: 'agent'` task runs on the standard builder with `ask_user` available and does not throw `Role "null" no longer exists`; a real sub-agent task with a missing role still fails with that error (existing test at `task-execution.test.ts:1761` stays green).
- **Store** (`workspace-store.test.ts`): a placement task appears in `listTasks`; it occupies its scope's running slot (`dequeueNext`/`getRunningEntry`); a stuck placement run escalates to `waiting_on_user` after the retry limit instead of failing; a real sub-agent task keeps all of its existing behavior.

## Documentation

- `GLOSSARY.md` "Sub-Agent Task": state the definition as the single predicate (`origin: 'agent'` with a dispatching parent).
- `GLOSSARY.md` "Placement Review Task": note it is an ordinary task for execution purposes, and that `origin: 'agent'` is provenance only.
- `TODO_LIST.md`: add an entry once implementation lands, per existing convention.
