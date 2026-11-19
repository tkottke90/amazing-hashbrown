# Workspace Chat: inline summary bubble, broken summary link, and hydrate-vs-live-stream race

## Problem

Three related defects surfaced from one real session (captured in a Thread
Report): a workspace chat thread was automatically summarized
(`maybeSummarizeWorkspace`, message-count threshold), and when the user
switched away and back to the workspace's Chat tab, the thread rendered as
empty even though nothing was lost server-side.

1. **The "View Summary" link is broken.** It points at
   `/api/v1/workspaces/:id/files/<path>` with no matching backend route, so
   Express's SPA catch-all serves `index.html` instead of a 404, and
   `preact-iso`'s router has no page for that path either — the user sees a
   blank result.
2. **A generated summary is invisible in the conversation itself.**
   `maybeSummarizeWorkspace` already persists the full summary as a
   `kind: 'summary'` thread message, but that row is also the new
   `lastSummarizedMessageId` cursor, and the cursor-based read filter
   (`afterMessageId`) excludes everything at or before it — including the
   row itself. The only surface for it is a static top-of-thread banner
   linking to the (broken) file route.
3. **`hydrate()` unconditionally replaces in-memory messages.** The
   workspace Chat tab re-hydrates on every mount
   (`workspace-chat-tab.tsx`'s `useEffect(() => { void thread.hydrate() },
[workspace.threadId])`), and `hydrate()` does `messages.value = hydrated`
   with no reconciliation. Two distinct consequences:
   - After an automatic summary with nothing sent since, the fetch's
     cursor-filtered tail is empty, so the already-rendered conversation is
     wiped down to nothing on remount — the reported bug.
   - Independent of summaries: if the Chat tab unmounts and remounts while
     a turn is actively streaming (e.g. the user switches tabs mid-response),
     the remount's `hydrate()` call can overwrite the live, in-progress
     assistant bubble with a stale, not-yet-fully-persisted server snapshot.

## Non-goals

- **Surfacing more than the current summary inline.** A thread can
  accumulate several summaries over its life. Only the one
  `workspace.lastSummarizedMessageId` currently points to renders as a
  bubble. Older summaries remain reachable only via the workspace's Files
  tab (`.hashbrown/summaries/*.md`) — this is the user's explicit "visual
  link back to what was summarized," not a "browse all summaries" feature.
- **Changing `afterMessageId`'s shared filter semantics.** It stays a
  strict `seq > cursor.seq` comparison everywhere (`thread-store.ts`,
  `workspace-summarizer.ts`'s own threshold counting). The fix is additive,
  at the one read path that serves the UI.
- **Backfilling frontmatter or migrating old summary rows.** Not touched —
  out of scope for this fix.
- **General network-race hardening of `hydrate()` beyond the
  live-stream case.** Only the "a turn is actively streaming on this
  `ThreadInstance`" condition is guarded. Other staleness races (e.g. two
  unrelated slow fetches resolving out of order with no stream involved)
  are not addressed here.
- **Removing `Workspace.summaryPath`** (the backend/workspace-level field)
  or its exposure on the thread GET response. Only the per-`ThreadInstance`
  `summaryPath` signal in `use-thread.ts` — whose only reader is the banner
  being removed — is deleted.

## 1. Fix the summary file link

The link needs the file-content route's required suffix:
`/api/v1/workspaces/${workspace.id}/files/${path}/content` (matching
`workspace-files.route.ts`'s `GET '/*/content'`). This link moves into the
new summary bubble (see §2) rather than staying in the banner, which is
removed.

## 2. Inline, collapsible summary bubble

### Backend: extract and extend the thread GET handler

`workspace-chat.route.ts`'s `GET '/:threadId'` currently builds its
response inline, calling `getThreadHandler` (from `threads.handlers.ts`)
directly in the route body — no dedicated, unit-testable handler function,
unlike `/replace` (`replaceThreadHandler` in `workspace-chat.handlers.ts`).

Add a new handler, `getWorkspaceChatThreadHandler`, in
`workspace-chat.handlers.ts`:

```ts
function getWorkspaceChatThreadHandler(
  threadStore: ThreadStore,
  threadId: string,
  workspace: Workspace,
  opts: { isTurnActive: (id: string) => boolean },
): HandlerResult<ClientThreadDetail & { summaryPath: string | null; summarizedAt: string | null }>
```

Behavior:

1. Call `getThreadHandler(threadStore, threadId, { afterMessageId:
workspace.lastSummarizedMessageId ?? undefined, isTurnActive:
opts.isTurnActive })` exactly as today, to get the metadata plus the
   post-cursor tail of messages.
2. If `workspace.lastSummarizedMessageId` is set, fetch that one row via
   `threadStore.getMessage(threadId, workspace.lastSummarizedMessageId)`
   (already used elsewhere in this route for `summarizedAt`) and convert it
   with the existing `toClientMessage`.
3. Return the same shape `getThreadHandler` returns today, but with
   `messages` = `[summaryMessage, ...tail]` when a summary row was found,
   else just `tail`. `summaryPath`/`summarizedAt` stay on the response as
   they are today (other consumers may still read them; only this route's
   own banner usage goes away — see below).

`workspace-chat.route.ts`'s `GET '/:threadId'` becomes a thin call into
this handler, matching the rest of the route file's existing pattern
(`result.ok` → status/json, same as every other route here).

No change to `getThreadMessages`/`getThread`'s `afterMessageId` filter
itself — this is purely additive, assembled one level up.

### Frontend: a new message kind and component

Add a `summary` variant to `ThreadMessage`
(`ui/src/types/thread-message.ts`):

```ts
| {
    kind: 'summary';
    id: string;
    content: string;
    summaryPath: string;
    seq?: number;
  }
```

New component `ui/src/components/workspace-summary-message.tsx` (same
tier as `task-run-marker-message.tsx`, `wiki-update-message.tsx`), wired
into `ThreadMessageItem`'s dispatcher (`thread-message.tsx`) with a new
`case 'summary':`. Rendering:

- Centered, visually distinct from a chat bubble (matches the "centered,
  labeled as summary" ask — same general treatment as other non-chat
  marker cards in this list, e.g. `TaskRunMarkerMessage`).
- Collapsed by default. Clicking the row toggles expand/collapse — same
  interaction already used for a superseded assistant bubble
  (`assistant-message.tsx`).
- Expanded state renders `content` as markdown (reusing whatever renderer
  assistant messages already use) and includes a "View raw file" link to
  `/api/v1/workspaces/${workspaceId}/files/${message.summaryPath}/content`
  (the corrected URL from §1). `workspaceId` must be threaded down to this
  component the same way `ThreadMessageItem` already receives `threadId`.

### Remove the top-of-thread banner

Delete the banner block in `workspace-chat-tab.tsx:275-287`
(`{thread.summaryPath.value && (...)}`). Since that was `ThreadInstance`'s
`summaryPath` signal's only reader, remove the now-dead plumbing from
`use-thread.ts`: the `summaryPath: Signal<string | null>` field on the
`ThreadInstance` interface, its `signal(null)` declaration, the
`summaryPath.value = data.summaryPath ?? null` line in `hydrate()`, and its
entry in the returned object. `Workspace.summaryPath` (the backend field,
`workspaces-api.ts`) and the thread GET response's own `summaryPath` key
are untouched (non-goal — not proven dead elsewhere).

## 3. `hydrate()` must not clobber a live turn

Inside `hydrate()` (`use-thread.ts`), after the fetch resolves and the
response is parsed, check `isStreaming.value` before applying any of it:

```ts
if (isStreaming.value) {
  modelHydrated.value = true; // still unblock the model-hydrated gate
  return; // the live SSE stream is already authoritative — don't overwrite it
}
```

This single guard, placed in the shared `hydrate()`, protects every
caller: the workspace Chat tab's mount effect, the global chat page's
`switchThread()`, and the manual "Summarise" button's own `await
thread.hydrate()`. Because `isStreaming` lives on the memoized
per-threadId `ThreadInstance` (not on the mounted component), it correctly
reflects "is this tab's own turn still streaming" across an
unmount/remount, and checking it at resolution time (not just at call
time) also covers the race where a turn starts streaming while the fetch
was in flight.

Combined with §2: a remount right after an automatic summary now shows at
least the summary bubble instead of an empty thread (the GET response is
never just an empty tail), and a remount mid-turn no longer discards the
in-progress response.

## Testing

- `workspace-chat.handlers.test.ts`: new tests for
  `getWorkspaceChatThreadHandler` — no summary yet (unchanged passthrough),
  a summary cursor set (summary message prepended ahead of the tail), and
  the tail being empty (response is exactly `[summaryMessage]`).
- A render test for `WorkspaceSummaryMessage`: collapsed by default,
  expands on click, raw-file link includes `/content`.
- `thread-message.test.tsx` (or equivalent dispatcher test): a `kind:
'summary'` message renders `WorkspaceSummaryMessage`.
- `use-thread.test.ts`: `hydrate()` is a no-op when `isStreaming` is
  already `true` at call time, and when it becomes `true` while the fetch
  is in flight (resolve-time check).
