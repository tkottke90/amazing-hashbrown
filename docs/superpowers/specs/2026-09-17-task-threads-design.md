# Task Threads — Design

**Date:** 2026-09-17
**Status:** Approved design (pre-work for #72, cron/scheduled tasks)
**Session:** Brainstorming session on task-thread visibility and lifecycle

## Problem

- Workspace-scoped tasks run inside the workspace's shared chat thread (`workspace.threadId`, type `workspace-chat`); run markers blend into the whole conversation and are easy to lose.
- Global tasks mint a private thread (type `'task'`, lazily in `api/src/agents/task-execution.ts` via `task.threadId ?? randomUUID()`), but it is invisible in the UI: the sidebar filters on `type:'chat'`, the frontend `ThreadSummary` type in `ui/src/hooks/use-thread.ts` doesn't include `'task'`, and neither `task-drawer.tsx` nor `tasks-api.ts` expose `threadId`.
- No general SSE broadcast mechanism exists; only the `getActiveSseWriter` forwarding shim for a client already watching a specific thread's writer slot.

## Goal

Every task gets its own thread regardless of origin, visible and navigable in the UI, with lightweight notifications back into the originating conversation. This is groundwork for #72 (scheduled/cron tasks), where run history must not pollute user conversations.

## Decisions (from brainstorming)

1. **Every task gets its own thread** — including workspace-scoped tasks; no reuse of the workspace chat thread.
2. **Completion notifications:** on terminal/blocking outcome, a short pointer message drops into the originating conversation linking to the task thread.
3. **UI access:** new paginated, filterable **Threads nav page** listing all threads of all types; main sidebar stays limited to 5–10 recent chat threads. `ThreadSummary` gains `'task'`.
4. **Task threads are read-only:** all interaction (cancel/pause/take over/resume/re-run) stays in the task drawer. Replying in task threads is deferred as a follow-up (via `waiting_on_user`).
5. **Live viewing:** opening a task thread mid-run attaches to the existing `getActiveSseWriter` shim for a live tail; fallback to load-once + refresh if attachment proves difficult. No new broadcast infra.

## Architecture

### 1. Data Model & Thread Lifecycle

**Thread creation**
- Every task, on first execution, gets its own thread with `type: 'task'` — including workspace-scoped tasks. Remove the fallback that reuses `workspace.threadId` in `api/src/agents/task-execution.ts`.
- Thread is minted lazily (`task.threadId ?? randomUUID()`), unchanged for global tasks; workspace-scoped tasks now take the same path.
- `task.workspaceId` remains a plain scope attribute — it no longer determines the thread.

**Lifecycle rules**
1. **Delete task → hard-cascade delete its thread** (and its messages). If the task is running: cancel/pause first, wait for graceful stop, then cascade.
2. **Task threads are not deletable from the Threads page.** Delete is disabled/hidden for any thread with `type: 'task'`; the API also rejects it server-side. Regular chat/workspace threads keep existing deletion behavior.
3. **Delete workspace → no cascade.** Tasks and their threads survive; `workspaceId` on the task is set to null.

**Schema impact**
- No new tables. The existing `threads` table already supports `type: 'task'`; frontend `ThreadSummary` union gains `'task'`.
- Task → thread link stays `task.threadId`; tasks API and task drawer expose it (read-only).
- Small addition: nullable `originThreadId` on the task, stored at creation time (see Data Flow).

### 2. Completion Notifications & UI Access

**Pointer messages**
- On `completed`, `failed`, `paused`, or `waiting_on_user`, write a short pointer marker message to the originating conversation (workspace chat thread for workspace-scoped tasks; the creating thread for global tasks).
- Format: `Task 'X' finished ✓ — View thread` (variants per outcome, e.g. `blocked ⏸ — awaiting your input`), linking to the task thread. Built on the `task-run-marker-message.tsx` / `sub-agent-notification.ts` patterns.
- Full activity stays in the task thread; the pointer is navigation only, not a mirror.

**Threads nav page**
- New sidebar entry **"Threads"** at the bottom: paginated list of all threads, all types (chat, wiki, workspace-chat, task), filterable by type, newest first.
- Main chat sidebar unchanged (5–10 most recent chat threads).

**Read-only task threads**
- No composer, no reply box. Drawer remains the sole control surface.

**Live viewing**
- Mid-run attachment via the existing `getActiveSseWriter` forwarding shim; SSE writer absent → load-once view with refresh button.

### 3. API Surface

- `tasks-api.ts`: expose `threadId` (read-only) on task objects and task drawer data.
- Thread list endpoint: pagination (following existing patterns), `type` filter, newest-first ordering, all thread types.
- Thread deletion endpoint: reject with 403/409 when `thread.type === 'task'`; client hides the affordance too.
- Thread read endpoint: serve `type: 'task'` threads to the thread view; the current `type:'chat'` gating moves server-side or widens.

### Data Flow

Task execution start → resolve/mint thread → stream events to the thread's SSE slot (existing writer path) → on terminal/blocking outcome, write pointer message to originating thread + mark task done.

Originating thread resolution: workspace-scoped tasks use the workspace chat thread; global tasks use the thread the task was created from (`originThreadId`, stored at task creation, nullable).

### Error Handling

- **Task deleted mid-run:** cancel/pause the agent, wait for graceful stop, then cascade-delete the thread (transactional where the store supports it).
- **Pointer write fails:** log and continue; task completion must not fail because a notification couldn't be written.
- **SSE writer absent** (task not running): thread view loads once, refresh button shown.
- **Origin thread missing/deleted:** skip pointer message, log only.

### Testing

- **Unit:** thread minting (first run mints, second run reuses); cascade delete for idle and running tasks; deletion rejection for task threads; `ThreadSummary` type handling.
- **Integration:** a task run produces messages in its own thread plus a pointer in the origin thread; workspace deletion leaves tasks/threads intact.
- **UI:** Threads page renders all types with the filter; task thread renders read-only, with live tail when running.

## Out of Scope

- Replying to / interacting inside task threads (follow-up via `waiting_on_user`).
- General SSE broadcast infrastructure (Option C) — the forwarding shim is sufficient.
- Cron/scheduling itself (#72); this spec is its groundwork.
