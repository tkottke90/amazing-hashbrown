# Focus Wiki Button

## Problem

Orienting the chat agent to a specific wiki domain (`wiki_orient`) is
currently a manual-prompt-only workflow — a user has to type something like
"Orient to the amazing-hashbrown wiki." into the chat box themselves. This is
unintuitive, especially set against other wiki actions (creating a new
domain, creating a new page) that are already buttons/forms rather than
freeform prompts the user has to compose from memory.

The user is most likely to want this at the exact moment they're already
looking at a specific wiki's documents — the Document tab of the Wiki view
(`ui/src/pages/wiki/document-view.tsx`), where the domain is already
selected via the sidebar's domain `<select>`.

## Design

### Location

A new full-width sidebar row in `DocumentView`, directly below the existing
"View Metadata" row and above "+ New page":

```
[ domain <select> ]
[ 🧭 Focus Wiki      ]   <- new
[ 📖 View Metadata    ]
[ ➕ New page          ]
```

Ordering rationale: "View Metadata" and "Focus Wiki" are both ways of
orienting yourself to the currently-selected domain (one loads it into the
document viewer, the other loads it into the agent's context); "+ New page"
is a content-creation action and stays last.

Reuses the existing row pattern already used by "View Metadata" / "+ New
page" (`flex items-center border-b border-border px-2 py-1.5` wrapper,
`flex items-center gap-1 rounded p-1 text-xs transition-colors` button) —
no new layout primitive needed.

### Behavior

```ts
function handleFocusWiki() {
  if (!domainId) return;
  newWikiThread();
  void sendWikiMessage(`Orient to the ${domainId} wiki.`);
}
```

- `newWikiThread()` (`use-wiki-ingestion.ts`) swaps `wikiThreadId` to a fresh
  UUID. This matches the existing ⟲ "New conversation" button in the chat
  header exactly — the previous thread isn't deleted, just no longer current
  — so this introduces no new discard-confirmation behavior beyond what
  already exists elsewhere in this view.
- `sendWikiMessage` sends the canned prompt on the new thread. The chat
  column is already visible side-by-side with the Document view (the Wiki
  view is desktop-only, two-column layout — see `wiki/index.tsx`'s "Mobile
  fallback" block), so the user sees the new thread and the agent's
  orientation response appear immediately with no navigation needed.
- `domainId` is the domain **id** (slug, e.g. `amazing-hashbrown`), not the
  `domain` field (a free-text description, e.g. "agent identity, values,
  decisions, and reflection" — see the Sept 30 wiki-binding-dropdown fix for
  the same id-vs-domain distinction). `wiki_orient`'s `wikiId` parameter
  expects exactly this id, so no display-name lookup is needed.

### Guards and visual state

- **Disabled** (not a silent no-op) when `!domainId` — same condition
  `handleViewMetadata` already guards on, but surfaced visually since there's
  no cached "last domain" to fall back to.
- **Active-state highlight**: the row uses the same `bg-sidebar-accent
  text-foreground` treatment as "View Metadata"'s active state, triggered by
  `wikiOrientedTo.value === domainId`. `wikiOrientedTo` (`use-wiki-ingestion.ts`)
  is already set by the `onWikiOriented` SSE callback and already drives
  `OrientationBadge` in the chat header — reusing it here means the sidebar
  and the chat header never disagree about "is this wiki oriented right
  now," and nothing new has to track that state.

### Label and icon

"Focus Wiki", with the `Compass` icon from `lucide-preact` (distinct from
`BookOpen` used by View Metadata and `Plus` used by New page).

## Testing

**Unit (`ui/test/`, Jest):**

- Row renders with "Focus Wiki" label and `Compass` icon.
- Disabled when no domain is selected (`domainId` falsy / "No domains yet").
- Click calls `newWikiThread()` then `sendWikiMessage` with
  `` `Orient to the ${domainId} wiki.` ``.
- Row carries the active-state class when `wikiOrientedTo.value === domainId`,
  and the default/inactive class otherwise.

**E2E (`e2e/`, Playwright, `@user-workflow`):**

- From the Document tab with a domain selected, clicking Focus Wiki starts a
  new thread (chat panel clears/resets) and the canned orientation message
  appears as a sent user turn. Per `e2e/AGENTS.md`'s SSE-mocking pattern,
  mock the `wiki_oriented` SSE event in the response so the test doesn't
  depend on a live model, and assert the OrientationBadge and the new
  sidebar active-state both reflect the mocked orientation.

No backend/API changes — `wiki_orient` and its SSE event already exist and
are unmodified by this feature.
