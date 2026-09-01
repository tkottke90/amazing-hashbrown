# Reuse resource card for wiki update notifications

Issue: [#100](https://github.com/tkottke90/amazing-hashbrown/issues/100)

## Problem

`wiki_update` chat notifications (`WikiUpdateMessage`) show a bare pill — an
icon, a page title, and a wiki-name badge — with no way to open the page
that was created or updated. This predates the "resource card" pattern
introduced in #81, which gives chat-surfaced actions (workspace/project
creation) a consistent card treatment: a type badge, key facts, and an
"Open →" link to the resource's detail page. Wiki updates need the same
navigation, using the shared presentational components from #81 rather
than duplicating card styling.

Two pre-existing data-quality issues in the current implementation block
this from being a pure UI change and must be fixed as part of the same
work, since the fix touches the exact lines involved:

1. **No page path is emitted.** `wiki_create_page` and `wiki_update_page`
   both know the page's `path` when they emit the `wiki_updated` SSE
   event, but neither includes it. Without the path, no link can be built.
2. **`pageTitle` is wrong for updates.** `wiki_update_page` emits
   `pageTitle: path` (the raw file path, e.g. `concepts/foo.md`) instead of
   the page's real title. `wiki_create_page` emits the real title
   correctly. Since the update-tool call site is being touched anyway to
   add path data, this is fixed at the same time rather than left
   inconsistent.

## Goals

- A `wiki_update` notification includes a working link that opens the
  created/updated page in the wiki document view.
- The card's visual treatment (badge, layout) is consistent with the
  resource cards from #81, composing the same shared `ThreadCardShell` /
  `CardBadge` components rather than duplicating styling.
- `wiki_update_page` reports the page's real title, matching
  `wiki_create_page`'s existing behavior.
- Historical `wiki_update` rows persisted before this change (no `path`,
  and a `pageKind` holding an old section-type string instead of
  `created`/`updated`) continue to render without error and without a
  broken/missing link.

## Non-goals

- No change to `resource-card-message.tsx` or the resource-card data model
  itself — only its shared presentational pieces (`ThreadCardShell`,
  `CardBadge`) are reused/extended.
- No backfill of historical `wiki_update` rows with a `path` or corrected
  `pageKind` — old rows keep rendering in a degraded (link-less) form.
- No change to the wiki write tools' external tool-call contract (schema,
  return string to the model) beyond the internal SSE event payload.

## Design

### Data flow

The page `path` and real `title` are already known inside the wiki write
tools at the point they emit the `wiki_updated` SSE event — they're just
not threaded through. This change plumbs both fields end-to-end:

1. **`api/src/services/wiki-write.ts`** — `WikiWriteResult` gains a
   `title: string` field.
   - `createWikiPage`'s `'written'` result already has `title` in scope
     (the tool's input param) — pass it through.
   - `updateWikiPage`'s `'written'` result gains `existing.title` (already
     read from the page's frontmatter earlier in the function) — pass it
     through.
2. **`api/src/agents/tools/wiki-create-page.tool.ts`** — the `'written'`
   case emits
   `{ type: 'wiki_updated', pageTitle: result.result.title, pageKind: 'created', wikiName: wikiId, path: result.result.path }`.
3. **`api/src/agents/tools/wiki-update-page.tool.ts`** — the `'written'`
   case emits
   `{ type: 'wiki_updated', pageTitle: result.result.title, pageKind: 'updated', wikiName: wikiId, path: result.result.path }`
   (previously `pageTitle: path`).
4. **`lib/llm-common-types/src/chat/sse-events.ts`** — `WikiUpdatedSchema`:
   - `pageKind` narrows from `z.string()` to `z.enum(['created', 'updated'])`
     for newly-emitted events.
   - New field `path: z.string()`.
5. **`api/src/agents/thread-message-writer.ts`** (`recordWikiUpdate`) and
   **`api/src/agents/stream-handler.ts`** (`drainAndRecordWikiUpdates`) —
   thread the new `path` argument through to the persisted
   `payload: { pageTitle, pageKind, wikiName, path }`, same pattern as the
   other three fields.
6. **`ui/src/types/thread-message.ts`** — the `wiki_update` variant gains
   `path?: string` (optional, since historical rows won't have it).
7. **`ui/src/hooks/use-thread.ts`** — the `'wiki_updated'` SSE case copies
   `evt.path` into the new `ThreadMessage`, same as the other fields.

`pageKind` stays typed as `string` (not a literal union) on the UI
`ThreadMessage` type and the persisted payload, since historical rows can
hold arbitrary old section-type strings (`'entity'`, `'concept'`, etc.) —
narrowing it would make old data untypeable. The card component treats any
value other than the literal `'updated'` as `created` (see below), which
degrades old create-tool rows sensibly rather than erroring.

### Components

`ui/src/components/wiki-update-message.tsx` is rewritten to compose the
shared card pieces introduced in #81 instead of its own inline markup:

- `ThreadCardShell` wraps the card (same shell `ResourceCardMessage` uses).
- Two `CardBadge`s on the first row:
  - The wiki-name badge — same `blue` variant as today.
  - A new action badge: `Created` (`green`) or `Updated` (`amber`). Mapped
    as: `message.pageKind === 'updated' ? 'updated' : 'created'` — so any
    non-`'updated'` value (including historical section-type strings)
    falls back to the `created`/green treatment instead of an unmapped or
    blank badge.
- Page title as bold text, same position as today.
- An "Open →" link (`ExternalLink` icon, same pattern as
  `ResourceCardMessage`'s button, using `preact-iso`'s `useLocation().route`),
  navigating to
  `` `/wiki?view=document&domain=${encodeURIComponent(message.wikiName)}&page=${encodeURIComponent(message.path)}` ``.
  Rendered **only when `message.path` is present** — for historical rows
  without a path, the card renders with no link and no error.

`ui/src/components/card-badge.tsx` gains two new `VARIANT_CLASSES` entries,
`green` and `amber`, following the existing `blue`/`violet` pattern
(Tailwind `bg-*-100`/`text-*-700` light, `dark:bg-*-900/30`/`dark:text-*-400`
dark).

### Error handling / backward compatibility

- A `wiki_update` row from before this change has no `path` and a
  `pageKind` that may be an old section-type string. The component must
  not throw or render a broken link in either case — verified by tests
  covering both a message with no `path` and a message with an
  unrecognized `pageKind`.
- No new failure modes are introduced server-side: `title` is populated
  from data already loaded during the write (page frontmatter for update,
  input param for create), so there's no new I/O or error path.

## Testing

- **API unit tests**
  - `wiki-write.test.ts` (or wherever `createWikiPage`/`updateWikiPage` are
    tested): `'written'` result includes the correct `title` for both
    create and update.
  - `thread-message-writer.test.ts`: `recordWikiUpdate` persists `path`
    into the row's payload alongside the existing three fields.
  - Tool tests for `wiki-create-page.tool.ts` / `wiki-update-page.tool.ts`:
    the emitted `wiki_updated` SSE event carries the correct `pageTitle`,
    `pageKind`, `wikiName`, and `path`.
- **UI unit tests (new file)** `ui/src/components/wiki-update-message.test.tsx`:
  - Renders the wiki-name badge and page title as today.
  - Renders the `Created`/green badge for `pageKind: 'created'` and the
    `Updated`/amber badge for `pageKind: 'updated'`.
  - Renders the `created`/green badge (not a blank/unmapped one) for a
    legacy `pageKind` value like `'entity'`.
  - Renders the "Open →" link when `path` is present, and clicking it
    routes to `/wiki?view=document&domain=<wikiName>&page=<path>`.
  - Renders with no link, and without throwing, when `path` is absent.
- **E2E (new)**: a Playwright case (mocking the chat SSE stream per
  `e2e/AGENTS.md`'s SSE-mocking pattern) that emits a `wiki_updated` event
  and asserts the resulting card shows the Open link and navigates to the
  correct wiki document view on click. No E2E coverage exists for
  `wiki_update` messages today; per `AGENTS.md`, this UI-behavior change
  ships with its own E2E coverage in the same PR.
