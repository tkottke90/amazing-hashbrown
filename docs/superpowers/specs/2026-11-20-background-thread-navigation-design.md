# Background Thread Navigation — Don't Cancel a Turn Just Because You Switched Threads

**Date:** 2026-11-20
**Status:** Draft
**Related:** `docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md`,
`docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md`,
`docs/superpowers/specs/2026-09-27-agent-wait-design.md`

---

## Problem

`2026-09-21-interactive-chat-cancel-design.md` deliberately decoupled turn cancellation from client
disconnection: closing a tab, losing network, or a mobile OS suspending a backgrounded tab should
never kill an in-flight turn. A turn only stops because something explicitly asked it to (the Stop
button) or a bounded provider timeout fired. The backend, and the live-event broadcast channel built
in `2026-09-23-live-event-broadcast-design.md` / `2026-09-27-agent-wait-design.md`
(`thread_turn_started`/`thread_turn_completed`, `backgroundTurnActive`), already fully support a turn
continuing to run on a thread nobody is currently watching.

The frontend undermines this on one specific path: navigating between threads in the same tab.
`ui/src/hooks/use-thread.ts`'s `switchThread`, `newThread`, and `forkThread` each check
`if (current.isStreaming.value) current.stopGeneration()` before switching away from the
currently-active thread — and `stopGeneration()` fires a real `POST /stop`, aborting the server-side
turn (`active-sse-writer.ts`'s `stopActiveTurn`). So the one case that reliably kills a turn
prematurely is also the most common one: clicking a different thread in the sidebar, clicking "New
conversation," or forking, all while a turn is still streaming in the thread you're leaving.

This defeats the benefit of a hosted application reachable from multiple devices: a turn started from
one device should keep running and be visible from any other device that opens the thread later,
exactly as the existing background-turn infrastructure already allows for headless turns and other
tabs. Today it only fails to work for your own foreground navigation.

---

## Non-goals

- Live, token-by-token catch-up when returning to or opening a backgrounded thread. The existing
  background-turn UX (a busy/generating indicator, then a full rehydrate once the turn completes) is
  kept as-is. Resuming the actual live stream for a second listener would require decoupling the
  single-writer-per-thread SSE mutex (`active-sse-writer.ts`) — out of scope here.
- Any change to the Stop button, the `/stop` route, or `active-sse-writer.ts`'s abort registry. Those
  are correct today and untouched.
- Any change to automated task cancellation (`active-task-abort.ts`) or to how headless turns
  (`headless-turn.ts`) claim a thread.
- Multi-process/horizontally-scaled broadcast. The live-event channel is a single in-memory registry
  on one backend process; this design relies on that already being the deployment model (per
  `2026-09-23-live-event-broadcast-design.md`'s own framing) and does not change it.
- Workspace chat (`workspace-chat-tab.tsx`) and wiki chat already don't have this bug — each
  workspace has exactly one fixed thread with no in-tab thread-switching, so there's no equivalent
  `switchThread`-style call to fix there.

---

## Design

### 1. Stop auto-cancelling on navigation

In `ui/src/hooks/use-thread.ts`, remove the `if (current.isStreaming.value) current.stopGeneration();`
line from all three call sites:

- `switchThread(id)`
- `newThread()`
- `forkThread(id, atSeq)`

Nothing else in these functions changes — title persistence, `activeThreadModel` resolution, and the
rest of their existing logic stay as they are. The thread being left simply keeps running: its
`ThreadInstance` is memoized for the life of the tab (`_instances` never evicts), so its in-flight
`consumeSsePost` call keeps updating that instance's `messages`/`isStreaming` signals in the
background, visible again the moment you switch back to it.

**Companion fix — avoid a hydrate/stream race on return.** `switchThread` unconditionally calls
`next.hydrate()` on the thread being switched *to*. If that thread is still streaming in this same tab
(you never left the tab, just navigated away and back), a full hydrate would refetch and could clobber
state the live stream is still actively appending to. Guard it the same way this file's own
`thread_turn_completed` handling already does: skip `hydrate()` when `next.isStreaming.value` is
already true.

### 2. Backend: report active-turn state per thread in the list

`listThreadsHandler` (`api/src/routes/v1/threads.handlers.ts`) gains the same optional `isTurnActive`
injection `getThreadHandler` already accepts for the single-thread GET, applied per row instead of
once:

```ts
export function listThreadsHandler(
  store: ThreadStore,
  filter?: { type?: ThreadType; excludeArchived?: boolean; updatedAfter?: string },
  opts: { isTurnActive?: (threadId: string) => boolean } = {},
): ThreadSummaryResponse[] {
  return store.listThreads(filter).map((t) => withAfterAgentInfo(t, opts.isTurnActive));
}
```

`ThreadSummaryResponse` gains `activeTurn: boolean`, the same field name and semantics the
single-thread detail response already uses. `threads.route.ts`'s `GET /` wires in the already-existing
`isTurnActive` helper (`getActiveSseWriter(threadId) !== undefined`) — no new backend concept, just one
more call site for a helper that already exists.

### 3. Frontend: live sidebar indicator

The sidebar's thread-list signal (`threads.value`) carries `activeTurn` from the response above on
load. `ui/src/hooks/use-live-events.ts`'s existing `thread_turn_started`/`thread_turn_completed` cases
get a companion patch to that list — set the matching thread's `activeTurn` to `true`/`false` — in
addition to the `markBackgroundTurn` call they already make against an *open* `ThreadInstance`. This
means a thread shows as generating in the sidebar even before you've ever opened it in this tab.
`thread-sidebar.tsx`'s `ThreadRow` renders a small spinner/indicator when `activeTurn` is true.

**Why this covers multiple devices for free:** the broadcast channel (`GET /api/v1/events`,
`active-task-abort.ts`'s sibling `broadcast.ts`) is one in-memory registry on the server process,
fanning out identically to every connected client, tab or device. A turn started from one device shows
as generating in the sidebar on any other connected device the moment it starts, and clears the moment
it completes — no device-awareness code needed, because the server has no notion of "device," only
"connected client."

---

## Error handling / edge cases

| Case | Behavior |
| --- | --- |
| User clicks Stop on a thread they're currently viewing (foreground or backgrounded) | Unchanged — still hits `/stop`, aborts the controller, same as today |
| Navigate away from a streaming thread, then back, same tab, turn still running | `switchThread` skips `hydrate()` (new guard); the live stream's own updates are shown uninterrupted |
| Navigate away from a streaming thread, then back, same tab, turn has since completed | `switchThread` calls `hydrate()` as before (guard only skips while still streaming), showing the final result |
| Thread opened on a second device/tab while its turn is running elsewhere | Already correct via `thread_turn_started` → `markBackgroundTurn(true)`; now also reachable, since the originating device no longer kills the turn on its own navigation |
| Multiple threads generating concurrently in one tab via plain navigation (not just multiple tabs) | Not a new risk — each thread's `ThreadInstance` is already independent, and server-side concurrency is already bounded by `provider-queue.ts`'s per-provider `maxConcurrency`, which predates this change |
| Forking a thread while it's streaming | Original thread keeps generating in the background after the fork, same as any other switch-away |

---

## Testing

Following this repo's conventions (Mocha/Chai for `api/`, Jest for `ui/`, `[unit]`/`[orchestration]`
tags):

- **`use-thread.test.ts` (Jest):** `switchThread`/`newThread`/`forkThread` no longer call
  `stopGeneration` when leaving a thread with `isStreaming.value === true` (replaces/updates any
  existing test asserting the old stop-on-switch behavior). `switchThread` skips `hydrate()` when the
  target thread's `isStreaming.value` is already `true`, and still calls it when `false`.
- **`threads.handlers.test.ts` (Mocha/Chai, orchestration):** `listThreadsHandler` reports
  `activeTurn: true`/`false` per row from an injected `isTurnActive`, and defaults to `false` when no
  `isTurnActive` is injected — same convention as `getThreadHandler`'s existing coverage.
- **`use-live-events.test.ts` (Jest):** `thread_turn_started`/`thread_turn_completed` patch the
  matching entry in `threads.value`'s `activeTurn`, in addition to the existing `markBackgroundTurn`
  call.
- **E2E (Playwright, mocked SSE per `e2e/AGENTS.md`'s pattern, `@user-workflow`):** start a turn in
  thread A, navigate to thread B, confirm A does not show a "Stopped" error and the sidebar shows A as
  generating; navigate back to A, confirm the in-progress content is intact (no hydrate clobber);
  confirm the sidebar indicator clears once the turn completes.

This is a UI/orchestration behavior change, not an LLM-behavior change (no prompt or model-output
semantics shift) — EDD's failing-eval-first requirement doesn't apply, the same classification
`2026-09-21-interactive-chat-cancel-design.md` gave itself.
