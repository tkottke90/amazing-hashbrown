# Monitoring: Task Queue & Provider Activity — Design

## Problem

Two related production pain points, both about visibility this app doesn't currently have:

1. A Task can be stuck in the Queue lane (running or about to run), and there's no way to find which workspace it belongs to short of opening workspaces one at a time. The sidebar Queue Widget already aggregates this data app-wide but only ever shows one current Task plus a count.
2. Providers have configured concurrency limits, but there's no way to see which threads are currently holding a slot against a given Provider, or backed up waiting for one — so there's no way to tell a Provider is overloaded until something downstream already timed out.

## Scope

Two monitoring panels on one page, independently toggleable between layout options, reusing existing backend capability wherever one already exists:

- **Task Queue Monitor** — see GLOSSARY.md § Monitoring
- **Provider Activity Monitor** — see GLOSSARY.md § Monitoring

Both are read/act surfaces over state the app already computes; neither introduces a new persistence layer.

## Prototype

[Queue & Provider Monitor](https://claude.ai/artifact/AM9VwcehyFiPkZV4uMkvq5) — interactive, reflects every decision below, including working drag-and-drop on the Provider Activity Monitor's Room layout.

## Task Queue Monitor

- **Data**: the same query the sidebar Queue Widget already runs (`getQueueHandler` in `tasks.handlers.ts` — `store.listQueue()` + `store.getRunningEntries()`), expanded from "current task + count" into a full table, with each row annotated with its Workspace (or Inbox).
- **Columns**: Task, Workspace, Pinned Provider, Status (pending/running), Elapsed, Actions.
- **Actions**: reuse `cancelTaskHandler`/`pauseTaskHandler`/`takeOverTaskHandler` through the existing Task Drawer — no new backend capability. A row opens the same Task Drawer the board and Inbox already use.
- **Pinned Provider switch**: reuses the existing Task `provider`/`model` PATCH (`patchTaskHandler`), which already rejects the change while `status === 'running'`. The switch control must surface that distinction in the UI itself: interactive for a `ready` Task (takes effect immediately, no interruption), locked/inert with an explanatory tooltip for a `running` one. No pause-then-patch-then-resume workaround is offered for a running Task — switching a running Task's Provider stays unsupported, full stop.
- **Layout**: Table. Cards and a horizontal Line layout were prototyped and set aside — Table is the shipped direction.
- **Explicitly out of scope**: Attention-lane Tasks (failed/blocked/waiting-on-user) — already have their own surfacing, not duplicated here. No automatic "stuck" detection — the Monitor shows status and age; judging "stuck" is left to the reader.

## Provider Activity Monitor

- **Data**: extend `ProviderQueue` (`api/src/services/provider-queue.ts`) to carry caller thread identity (`threadId`, resolved to a thread-kind label — chat/wiki/workspace-chat/task) alongside each acquired or queued slot. `ProviderQueue` currently tracks only counts, so this is new, in-memory-only state — every `acquireSlot`/`withSlot` call site already has `threadId` in scope at the point it's called (confirmed across `stream-handler.ts`, `workspace-chat-stream-handler.ts`, `headless-turn.ts`, `task-execution.ts`), so no new plumbing is needed to get it there.
- **Delivery**: pushed live over the existing app-level broadcast channel (`GET /api/v1/events`, `services/broadcast.ts`) — the same mechanism other live board/thread state already uses. No polling.
- **Layout — Room**: a two-column row, Green Room on the left (30% width) and the Provider stack on the right (70%). Providers render as horizontal bars, one per Provider, stacked top to bottom; bar thickness is that Provider's configured `maxConcurrency` (its capacity), a stable structural property that doesn't jitter with load. Inside a bar, one dot per occupied slot (filled) or free slot (dashed outline). The Green Room holds every Provider's own Provider Line, each a dashed line running from that Provider's bar into the Green Room at the same height, with everything currently waiting for that Provider queued along it, in order. Table, Cards, and a per-row Diagram layout were prototyped and set aside; Room is the shipped direction.
- **Drag-and-drop**: dragging a Task's dot onto a Provider's bar re-pins the Task's Pinned Provider to that Provider — seats it immediately if a slot is free, otherwise it lands on that Provider's Provider Line, same PATCH as the Task Queue Monitor's switch control and under the same running-Task restriction (only a non-running Task's dot is draggable). See ADR-0068 for the two things this deliberately doesn't do: distinguish _why_ something is on a Provider Line, and let a user deliberately park a Task waiting on a Provider that has an open seat.

## Visual design

A minimal, single-theme sci-fi HUD skin: one monochrome cyan accent for structure and headers (no second "brand" hue), thin 1px hairline borders, small chamfered panel corners, Rajdhani for text and Share Tech Mono for numeric readouts (elapsed time, capacity fractions), flat — no glow — except the Provider Activity Monitor's Diagram layout keeps a single emphasized amber arrow where a Provider is backed up, since that's the one signal in that view actually worth drawing the eye to. See the prototype for the full treatment; status colors (good/warn/critical/idle) stay semantically distinct throughout.

## Out of scope / deferred

- Automatic "stuck" Task detection (Task Queue Monitor)
- Distinguishing the two reasons a request sits in the Green Room (ADR-0068)
- A deliberate "wait here even though a seat is open" gesture (ADR-0068)
- Attention-lane visibility in the Task Queue Monitor
