# Scheduled Task Deduplication — Design

**Date:** 2026-11-06
**Status:** Draft
**Related:** [Issue #365](https://github.com/tkottke90/amazing-hashbrown/issues/365), [Cron Task Triggers design](./2026-09-26-cron-task-triggers-design.md) (data model for `cron_once`/`cron_repeat` and `trigger_config`), `GLOSSARY.md` → "Scheduled Task Deduplication" (**Duplicate Signature**, **Matching Time Slot**, **Duplicate Time Slot Tolerance**, **Reused Task**), [ADR-0058](../adr/0058-scheduled-task-dedup-uses-string-match-not-embeddings.md)

---

## Goal

Stop two independently-created `cron_once`/`cron_repeat` tasks from ending up as separate rows that both fire for what is really the same scheduled work — the observed failure in #365.

---

## Problem

Nothing today checks whether a new scheduled task's title/description/schedule already matches an existing task before inserting it. The only existing dedup mechanism, `alreadyQueued` in `routes/v1/tasks.handlers.ts`, guards against re-queuing a second run of the _same_ `taskId` — it does nothing for two _distinct_ `Task` rows that independently describe the same goal and schedule. Both creation paths — the REST `createTaskHandler` and the agent-facing `create_tasks` tool (`agents/tools/create-tasks.tool.ts`) — can produce this, and in the observed incident did: two separate "One-off Scheduler trigger test" tasks were created for the same ~13:05 UTC verification window and both fired, each writing its own duplicate run-history entry.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Enforced once, in `workspace-store.ts`'s `createTask`/`createTasks` — not duplicated in the REST handler and the tool.                                                                                                                                                                       | Both existing creation paths share these two store methods already; checking here covers both for free and can't drift between them.                                                                                                                                                                                    |
| D2  | Only `cron_once`/`cron_repeat` tasks are eligible, both as the new request and as a candidate match. A plain (`chat`-triggered) one-shot task is never checked.                                                                                                                              | "Matching Time Slot" only means something for a task that has a schedule; a one-shot task has none to compare.                                                                                                                                                                                                          |
| D3  | A candidate match may be in **any** status (including `done`, `cancelled`, `failed`) — status is not a filter.                                                                                                                                                                               | Per the issue text ("existing open **or done** task"); a `done` or `cancelled` prior attempt is still evidence the slot's already spoken for.                                                                                                                                                                           |
| D4  | Comparison scope is same-`workspaceId` only. Workspace-less (Inbox) tasks compare only against other workspace-less tasks, never across that boundary.                                                                                                                                       | A workspace task and an unrelated Inbox task with similar wording aren't actually competing for the same slot.                                                                                                                                                                                                          |
| D5  | A candidate counts as a duplicate only when **all** of: Duplicate Signature matches, Matching Time Slot holds, and `trackerId` matches (including both `null`).                                                                                                                              | Signature+slot alone can false-positive across two differently-tracked pieces of work that happen to share wording (e.g. two issues both titled "Fix flaky test," scheduled at the same time); requiring `trackerId` too closes that gap for free.                                                                      |
| D6  | On a match, **reuse**: no new row is inserted; the response for that item carries the existing task's `id`/`title` plus `reused: true`. The existing task is left completely unmodified (no `updatedAt` bump, no field writes).                                                              | Matches the issue's own proposed fix; gives the caller (agent or UI) something actionable instead of a bare rejection, and "untouched" keeps reuse a pure no-op rather than a hidden side effect on an unrelated task.                                                                                                  |
| D7  | Within one `create_tasks` batch, list entries are also checked against each other, in list order — a later entry that duplicates an earlier one in the same call reuses it instead of both being inserted.                                                                                   | The same failure mode can happen within a single batch (e.g. an accidental repeat in one call), not only across separate calls.                                                                                                                                                                                         |
| D8  | No escape hatch / force flag to bypass the check.                                                                                                                                                                                                                                            | Reuse (not rejection) already means nothing is lost. A bypass solves a problem nobody's hit yet and reopens the exact hole this issue closes; add one later as its own issue if a real need shows up.                                                                                                                   |
| D9  | Matching technique: deterministic normalized-string comparison, not embeddings. See ADR-0058.                                                                                                                                                                                                | Keeps `createTask`/`createTasks` synchronous, deterministic, and provider-independent. Full rationale in ADR-0058.                                                                                                                                                                                                      |
| D10 | `cron_once` time slot: `fireAt` within a new configurable tolerance, `tasks.duplicateTimeSlotToleranceMinutes` (default **10**). `cron_repeat` time slot: exact normalized `expression`+`timezone` match, no tolerance. `cron_once` and `cron_repeat` are never compared against each other. | The observed incident's two fire times were ~76s apart, not identical, so `cron_once` needs a tolerance window; a recurring schedule is either the same schedule or it isn't, so `cron_repeat` doesn't. Cross-type comparison (a point-in-time vs. a recurring schedule) is a separate, harder question — out of scope. |

---

## Non-goals

- **Fuzzy/semantic ("close text-similarity") matching.** See ADR-0058 — explicitly deferred, not forgotten.
- **An override/force flag to bypass the check** (D8).
- **Retroactively cleaning up already-created duplicate tasks or their run-history entries.** This design only prevents new ones; the existing duplicate pair from the incident, if still present, is a one-off manual cleanup, not something this change touches.
- **Cross-type time-slot comparison** between `cron_once` and `cron_repeat` (D10).
- **Deduplication of plain, unscheduled (`chat`-triggered) tasks** (D2).

---

## Open implementation notes (not design decisions — flagged for the implementer)

- `tasks.duplicateTimeSlotToleranceMinutes` is a new config value; add it to `AppConfigSchema`/`env` following the existing `tasks.doneRetentionDays` pattern (see ADR-0031).
- A task's `description: null`/`undefined` normalizes to an empty string before the Duplicate Signature comparison described in `GLOSSARY.md`.
