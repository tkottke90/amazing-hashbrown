# Thread Report Access on Task Runs, and a Threads List Page

## Problem

Wiki Chat, Workspace Chat, and plain chat threads (via the sidebar's "⋮"
menu) can each open `/api/v1/threads/:id/report` in a new tab. Task-run
threads (`type: 'task'`, rendered by `TaskRunView` at `/chat/:id`) have no
such affordance anywhere — their header has nothing for it. Separately,
there is no page that lists threads of every type together; a user who
wants to find and open a given task-run thread (to pull its report, or
just to look at it) has no listing to find it from.

This design adds the report button to task-run threads, and adds a
dedicated `/threads` list page covering all four thread types
(`chat`, `wiki`, `workspace-chat`, `task`), each row offering the same
report action.

## Design

### 1. Shared `ThreadReportButton` component

The "open the thread report" action is currently copy-pasted three times:

- `ui/src/pages/wiki/ingestion-chat.tsx:102-109` (icon button)
- `ui/src/pages/workspaces/workspace-chat-tab.tsx:150-159` (icon button)
- `ui/src/components/thread-sidebar.tsx:201-206` (`DropdownMenuItem`)

This design adds two more call sites (below), which would make five copies
of the same `window.open(`/api/v1/threads/${id}/report`, '_blank')` call.
Per AGENTS.md's Composition over Customization principle ("component used
by 2+ pages → `src/components/`"), this is extracted into one shared
component instead:

`ui/src/components/thread-report-button.tsx`:

```tsx
interface ThreadReportButtonProps {
  threadId: string;
  variant?: 'icon' | 'menu-item';
}

export function ThreadReportButton({ threadId, variant = 'icon' }: ThreadReportButtonProps) {
  const open = () => window.open(`/api/v1/threads/${threadId}/report`, '_blank');

  if (variant === 'menu-item') {
    return (
      <DropdownMenuItem onSelect={open}>
        <FileDown class="size-4" />
        Generate thread report
      </DropdownMenuItem>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title="Generate thread report"
      class="flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground transition-colors"
    >
      <Download class="size-3.5" />
    </button>
  );
}
```

- `variant="icon"` (default) replaces the raw `<button>` markup in
  `ingestion-chat.tsx` and `workspace-chat-tab.tsx`, and is used by the two
  new call sites below.
- `variant="menu-item"` replaces the `DropdownMenuItem` in
  `thread-sidebar.tsx`.
- One icon (`Download`, matching the two existing icon-button sites) and
  one tooltip string everywhere, instead of three independently
  maintained copies.

### 2. Task-run header gets the button

`ui/src/pages/chat/task-run-view.tsx`'s `<header>` (line 61-89) already has
a back button, title, and status badges. Add `<ThreadReportButton
threadId={threadId} />` to that row (`TaskRunView` already receives
`threadId` as a prop — no new data needed). Plain chat threads are
unchanged; they keep using the sidebar's dropdown menu item.

### 3. Backend: list all thread types

`ThreadStore.listThreads()` (`api/src/services/thread-store.ts:301`)
already supports an unfiltered query (`listThreads()` with no argument
returns every type, ordered by `updated_at DESC`) — it just has no caller
today. `listThreadsHandler` (`api/src/routes/v1/threads.handlers.ts:124`)
hardcodes `{ type: 'chat' }`.

Extend the existing `GET /api/v1/threads/` route (`threads.route.ts:31`)
with an optional `type` query param, rather than adding a new path —
adding a sibling path like `/all` would need to be registered before the
`/:id` route to avoid Express matching it as `id: 'all'`, which is an easy
footgun to introduce by accident later. A query param on the existing
route avoids that entirely:

```ts
// threads.handlers.ts
export function listThreadsHandler(
  store: ThreadStore,
  filter?: { type: ThreadType },
): ThreadSummaryResponse[] {
  return store.listThreads(filter).map(withAfterAgentInfo);
}
```

```ts
// threads.route.ts
threadsRouter.get('/', (req: Request, res: Response) => {
  const { type } = req.query as { type?: string };
  if (type === undefined) {
    res.json(listThreadsHandler(getThreadStore(), { type: 'chat' })); // unchanged default
  } else if (type === 'all') {
    res.json(listThreadsHandler(getThreadStore())); // no filter — every type
  } else if (isThreadType(type)) {
    res.json(listThreadsHandler(getThreadStore(), { type }));
  } else {
    res.status(400).json({ error: `Unknown thread type "${type}"` });
  }
});
```

(`isThreadType` is a small new type guard over `ThreadType`'s four
literals.) No param keeps today's behavior exactly as-is — the sidebar's
existing `fetch('/api/v1/threads')` call (`use-thread.ts:115`) needs no
changes. `ThreadSummaryResponse` already carries `type`, `title`, and
`updatedAt`, which is all the new list page's columns need — no new
response type or per-type enrichment (task-run / workspace join) is added.

### 4. New Threads list page

`ui/src/pages/threads/index.tsx` (`ThreadsView`), routed at `/threads` in
`app.tsx`, structurally mirrors `WorkspacesView`
(`ui/src/pages/workspaces/index.tsx`):

- Filter tabs: `all / chat / wiki / workspace-chat / task`, same toggle-row
  pattern as `FilterTab` in `WorkspacesView` (client-side filtering over
  an already-fetched list, consistent with that page's `workspaces`
  are fetched once and filtered in a `useComputed`).
- Search `Input` with a `Search` icon, substring match against `title`,
  no debounce — same as `WorkspacesView`.
- A hand-rolled `<table>`: columns are a type badge, title (links to
  `/chat/:id`), updated-at (relative time, via the same
  `formatRelativeTime` helper `WorkspacesView` already has — move it to
  `ui/src/lib/utils.ts` since it's now used by two pages), and a report
  button cell (`<ThreadReportButton threadId={t.id} />`).
- Inline empty state when the filtered list is empty, matching
  `WorkspacesView`'s `FolderOpen`-icon treatment.

Data: a new `fetchAllThreads()` in `ui/src/hooks/use-thread.ts`, calling
`GET /api/v1/threads?type=all`, stored in its own local signal — **not**
the existing module-level `threads` signal, which must stay chat-only
(the sidebar list depends on it holding only `type: 'chat'` threads).

Row click-through reuses the existing generic `/chat/:id` route as-is for
every type. This is an accepted, pre-existing behavior, not a new risk
this page introduces: `ChatRoot` (`ui/src/pages/chat/index.tsx:133`)
already renders any non-`task` thread (so `wiki` and `workspace-chat`
threads too) via the normal interactive `ThreadView`, including calling
`switchThread()` — the same thing that already happens today if that URL
is opened any other way (e.g. a bookmarked link). `task` threads already
route correctly to the read-only `TaskRunView`.

Nav entry: add `<a href="/threads">` to `ui/src/components/thread-sidebar.tsx`
alongside the existing Inbox/Workspaces/Wiki/Settings links (`lines
340-400`), same active-state styling pattern, using `MessagesSquare` from
`lucide-preact` (not already in use among those four icons).

## Out of scope

- Per-type enrichment in the list (task run number/status, owning
  workspace name) — the list shows only generic columns; full detail is
  one click away at `/chat/:id`.
- Pagination — matches `WorkspacesView`'s existing fetch-all-and-filter-
  client-side approach; thread volume is assumed to stay in the same
  range workspaces already does.
- Any change to how `wiki`/`workspace-chat` threads behave once opened at
  `/chat/:id` — that behavior already exists today and is unchanged by
  this design.

## Testing

- Unit (Jest): `ThreadReportButton` renders both variants and calls
  `window.open` with the right URL.
- Unit (Mocha): `listThreadsHandler` filter behavior (`{type: 'chat'}`
  default, explicit type, no filter for `all`); the route's 400 on an
  unknown `type` value.
- Orchestration (Mocha + supertest): `GET /api/v1/threads` with no query,
  `?type=task`, `?type=all`, and an invalid `?type=` value.
- Orchestration (Jest + Testing Library): `ThreadsView` renders mixed-type
  rows, filter tabs narrow the list, search filters by title.
- E2E (`@user-workflow`): open a task run at `/chat/:id`, click its new
  report button, confirm a new tab opens the report URL; visit `/threads`,
  confirm it lists threads of multiple types and that a row's report
  button opens the report.
