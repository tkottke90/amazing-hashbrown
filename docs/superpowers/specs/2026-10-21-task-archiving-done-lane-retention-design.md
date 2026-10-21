# Task Archiving & Done Lane Retention — Design

**Date:** 2026-10-21
**Status:** Proposed
**Related:** [GLOSSARY.md "Task Archiving & Done Lane Retention"](../../../GLOSSARY.md), [ADR-0031](../../adr/0031-done-lane-retention-window-defaults-to-5-days.md), [ADR-0032](../../adr/0032-archived-tasks-reject-board-moves-aged-out-dont.md), [ADR-0033](../../adr/0033-task-archivability-keyed-on-board-lane-not-status.md), [ADR-0034](../../adr/0034-unarchiving-a-task-bumps-updatedat.md), [Thread Archiving & Sidebar Retention design](./2026-10-20-thread-archiving-sidebar-retention-design.md) (direct precedent for this feature's two-mechanism shape), [Kanban board v2 design](./2026-09-28-kanban-board-v2-design.md) (Board Lane / `board-rules.ts` this feature builds on)

---

## Goal

The Workspace board's Done lane and the Inbox's task list both grow without bound today — nothing ever leaves either view once a task reaches Done. Give the user the same two independent, composable ways to declutter that the Thread Archiving feature already shipped for the chat sidebar, applied to tasks instead:

1. **Archive** a task by hand — it leaves the Done lane and the Inbox for good (until Unarchived), and board-moves on it are blocked, but it stays fully recoverable.
2. A configurable **Done Lane Retention Window** — Done-lane tasks inactive long enough quietly stop showing on their own, with zero effect on the task itself; anything that touches it again brings it right back.

## Problem

The board's Done lane (`ui/src/pages/workspaces/task-board/`) and the Inbox (`ui/src/pages/inbox/index.tsx`) both list every task that reaches a terminal state, forever, with no filtering by age or any way to put one away short of Delete. See GLOSSARY.md's new "Task Archiving & Done Lane Retention" section for the vocabulary (**Archived Task**, **Aged-Out Task**, **Archive**/**Unarchive**, **Done Lane Retention Window**, **Show Archived**) this design uses throughout — it is not restated here.

---

## Decisions

The grilling session settled these; rationale for the four non-obvious ones is in their ADRs rather than repeated here.

| #   | Decision                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Two independent mechanisms, mirroring Thread Archiving: manual **Archive**/**Unarchive**, plus an automatic **Done Lane Retention Window**.                                                                                                                                |
| D2  | Scope: both the **Workspace board's Done lane and the Inbox** — same `Task` row, same unbounded-growth problem either place.                                                                                                                                               |
| D3  | Status scope: the whole existing Done-lane group (`done` + `cancelled`); `failed` stays excluded (it lives in the separate Attention lane and isn't part of this clutter complaint).                                                                                       |
| D4  | Done Lane Retention Window is a **single global config value**, no per-workspace override — same single-local-user config model as `chat.sidebarRetentionDays`.                                                                                                            |
| D5  | Defaults to **enabled at 5 days** (see ADR-0031), not disabled.                                                                                                                                                                                                            |
| D6  | **Archived Task rejects reopen/rerun/reschedule board-moves**; **Aged-Out Task does not** — see ADR-0032.                                                                                                                                                                  |
| D7  | "Show everything" is a **Show Archived toggle on the existing board and Inbox surfaces**, not a new global page — no equivalent of the Threads page exists for tasks and none is needed.                                                                                   |
| D8  | Archive is **per-task only** — no bulk "Archive all Done" action for now.                                                                                                                                                                                                  |
| D9  | Archivability and the Retention Window key off **Board Lane membership** (`board.lane === 'done'`), not literal status — see ADR-0033.                                                                                                                                     |
| D10 | **Unarchive bumps `updatedAt`** — a deliberate divergence from Thread Archiving's precedent — see ADR-0034.                                                                                                                                                                |
| D11 | An Archived Task carries a **visible badge** when revealed via Show Archived; an Aged-Out Task carries none — the inverse of Thread Archiving's call, because here both states share one combined toggle and the user needs to tell which still require an Unarchive step. |
| D12 | **Delete and metadata edits (title/description/due date) stay allowed** on an Archived Task — only the board-move actions are rejected.                                                                                                                                    |
| D13 | Archive/Unarchive reachable from **a Done-lane card's own menu, an Inbox row's own action, and the Task Drawer**.                                                                                                                                                          |
| D14 | The Show Archived toggle **resets to off on every page load** — never remembered across sessions, matching this app's existing convention for display toggles (e.g. Dashboard's Edit Mode).                                                                                |

## Non-goals

- A per-workspace override of the Done Lane Retention Window (D4).
- A bulk "Archive all Done" action (D8).
- A new global "All Tasks" page (D7).
- Any change to `failed`-status tasks or the Attention lane (D3).
- Remembering the Show Archived toggle's state across page loads (D14).
- Blocking Delete or metadata edits on an Archived Task (D12).

---

## Design

### 1. Data model (`api/src/services/workspace-store.ts`)

- New migration adding a nullable `archived_at TEXT` column to `tasks` (check the file's version-number ledger comment for the next free version at implementation time).
- `Task` gains `archivedAt: string | null`; `RawTaskRow` gains the matching raw column.
- New methods `archiveTask(id): Task | null` and `unarchiveTask(id): Task | null`. `archiveTask` does not bump `updatedAt`. `unarchiveTask` does bump `updatedAt` (D10/ADR-0034) — the one place this feature's store methods diverge from `archiveThread`/`unarchiveThread`'s shared pattern.
- `listTasks`'s filters (`TaskListFilters`, currently `workspaceId`/`status`) gain `excludeHiddenDone?: boolean` — true applies both the Archived exclusion and the Retention Window cutoff together in one pass (D7's combined toggle), computed against the same Board Lane facts `buildBoardContexts` already assembles rather than a second query.

### 2. Config (`api/src/config/env.ts`)

- New `TasksSchema` (or an existing tasks-config section, if one already exists by implementation time) gains `doneRetentionDays: z.number().int().min(0).default(5)` (D5/ADR-0031). `0` disables the window entirely, same convention as `chat.sidebarRetentionDays`.
- Settings UI: a new numeric field alongside wherever task-related settings already live — "Hide Done tasks from the board and Inbox after (days) — 0 to disable."

### 3. API

`api/src/routes/v1/tasks.route.ts`:

- `GET /` and the Inbox's equivalent fetch both default to `excludeHiddenDone: true`; the Show Archived toggle's request passes `excludeHiddenDone: false` instead (mirrors Thread Archiving's D13 — retention/archive filtering applies only to the normal, unfiltered-by-the-user fetch).
- New `POST /:id/archive` and `POST /:id/unarchive`, mirroring the existing thread archive/unarchive route shape. Each 404s if the task doesn't exist and 400s if the task isn't currently in the Done lane (D9 — `board.lane !== 'done'` for the task's current state, computed the same way `withBoard` already does).

`api/src/routes/v1/tasks.handlers.ts`:

- `archiveTaskHandler` / `unarchiveTaskHandler`, same `HandlerResult<Task>` shape as the existing patch/move handlers.
- `moveTaskHandler` (and `board-rules.ts`'s `planFrom`) gain a guard: if `task.archivedAt` is set, every move from the `done` source is rejected (409) except none exist to Unarchive through directly — Unarchive is its own route, not a board-move (D6/ADR-0032). An Aged-Out Task takes no new guard at all; it was never anything but filtered out of the list.
- `patchTaskHandler` is unaffected — title/description/due-date edits and delete stay allowed regardless of `archivedAt` (D12).

### 4. UI

`ui/src/services/tasks-api.ts` / `ui/src/hooks/use-tasks.ts`:

- `Task` gains `archivedAt: string | null`.
- `refreshTasks` gains a `showArchived` flag that flips the `excludeHiddenDone` query param (D7's single combined toggle).
- New `archiveTask(id)` / `unarchiveTask(id)`, alongside existing task mutations.

`ui/src/pages/workspaces/task-board/`:

- A **Show Archived** toggle on the board (resets to off every load, D14). When on, archived + aged-out Done-lane cards reappear with Archived ones carrying a small badge (D11).
- The Done-lane card's own menu (`board-card.tsx`) gets an Archive/Unarchive item (D13), alongside the existing move/retry actions. Attempting a move on an Archived card surfaces the 409's reason the same way any other rejected move already does (`board-move.ts`'s existing rollback-with-reason path) — no new UI pattern needed.

`ui/src/pages/inbox/index.tsx`:

- The same Show Archived toggle, filtering `inboxTasks` the same combined way.
- Each `TaskRow` gets an Archive/Unarchive row action (D13) alongside opening the Task Drawer.

`ui/src/components/task-drawer.tsx` (or wherever its action buttons live):

- An Archive/Unarchive action available whenever the open task's Board Lane is `done` (D13), regardless of which surface opened the drawer.

Settings UI: a new numeric field for `doneRetentionDays`, wired through the same settings round-trip pattern the chat retention field already uses.

---

## Self-review

- **Placeholders:** none — every decision resolves to a concrete file, function, or route; nothing marked TODO.
- **Internal consistency:** D9 (lane-based scope) is carried through the archive route's 400 guard, the board-move 409 guard, and `excludeHiddenDone`'s shared computation — all three read the same `board.lane` fact rather than three separate status checks. D6/D11/D12 agree: Archived blocks only board-moves, never Delete/edit, and only Archived (not Aged-Out) gets a badge — the one asymmetry this design has relative to Thread Archiving, called out explicitly in ADR-0032 and D11 rather than left implicit.
- **Scope check:** every item in Non-goals was explicitly raised and ruled out during grilling, not assumed.
- **Ambiguity check:** the one real divergence from the Thread Archiving precedent — Unarchive bumping `updatedAt` — is called out in D10/ADR-0034 rather than silently copied or silently changed.
