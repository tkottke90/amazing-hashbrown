# LLM Wiki UI & Direct Authoring Tools — Design

**Date:** 2026-07-29
**Status:** Approved
**Depends on:** Connect LLM-Wiki to Chat Agent (complete)
**Unblocks:** Web/URL Ingestion Tool (UI stubs land here; backend wired when that item ships)

---

## 1. Problem & Goal

When a user starts a fresh wiki, building domain knowledge purely through conversation is slow and frustrating — there is no way to see what the wiki contains, navigate its structure, or provide content in bulk. This feature adds:

1. A dedicated UI for browsing and authoring wiki content (graph view, document editor)
2. A dedicated ingestion interface — a wiki-focused chat agent — for feeding information to the wiki, including future support for document and URL ingestion

The agent remains the write path. The UI makes the wiki visible and navigable; it does not bypass the agent for mutations.

---

## 2. Scope & Constraints

**In scope:**
- `/wiki` top-level route and nav entry
- Graph view (all domains, D3 force layout, domain filter)
- Document view (page list sidebar, raw markdown editor, preview toggle)
- Ingestion chat panel (wiki-building agent, orientation indicator, domain creation form)
- URL/document ingestion affordances as UI stubs (backend wired when Web/URL Ingestion Tool ships)
- New REST read endpoints for graph, domain list, page list, page content
- `wiki_oriented` SSE event

**Out of scope:**
- Mobile layout (deferred — requires a separate design)
- WYSIWYG editing
- Drag-to-resize split panel
- Direct REST write endpoints (all writes go through the ingestion agent)
- URL/document ingestion backend (Web/URL Ingestion Tool, item #1 on the outstanding list)

---

## 3. Routing & Navigation

**Router:** Add `wouter` to the UI package. This also unblocks the Multi-Conversation Support item which names `wouter` as the recommended router.

**Routes:**

| Path | Component |
|---|---|
| `/` | `ThreadView` (existing, unchanged) |
| `/wiki` | `WikiView` (new) |

**Nav bar:** Add a `BookOpen` icon link to `/wiki` in the existing nav bar alongside the Settings icon stub. The active route gets a filled-icon active state; inactive routes use outline icons.

**Mobile (`< 768px`):** The `/wiki` route renders a centered "not available on mobile" placeholder with a `Monitor` icon. No mobile wiki design in this spec.

---

## 4. API Layer

All reads go through new REST endpoints. All writes go through the ingestion chat agent — no write REST endpoints are added for wiki content.

### New Endpoints

| Method | Path | Handler |
|---|---|---|
| `GET` | `/api/v1/wiki/domains` | `registry.list()` — returns id, name, routing notes for all active domains |
| `GET` | `/api/v1/wiki/graph` | `buildGraph()` across all domains, merged; metadata page types (schema, log, index) stripped server-side |
| `GET` | `/api/v1/wiki/domains/:id/pages` | `wiki.listPages()` for one domain, filtered to non-metadata types |
| `GET` | `/api/v1/wiki/domains/:id/pages/*` | `wiki.readPage()` — returns frontmatter + markdown body |

### Live Updates

The existing `wiki_updated` SSE event (emitted by the agent after every `commitPage()`) is the UI's signal to invalidate and refetch the graph, page list, and active page. No polling is needed — the UI listens to the ingestion thread's SSE stream.

### Graph Caching

The `/api/v1/wiki/graph` endpoint computes fresh on each request by calling `buildGraph()` across all domains.

```typescript
// TODO(perf): buildGraph() is called on every request. For large wikis this
// may become slow. A short-lived in-memory cache invalidated on wiki_updated
// (or an incremental edge-patch approach) would reduce latency here.
```

---

## 5. Page Layout

`WikiView` is a fixed two-column layout, desktop and tablet only (`≥ 768px`).

```
┌─────────────────────────────────┬──────────────────┐
│  [Graph | Document]  [filters]  │  Wiki Chat       │
│                                 │  ─────────────   │
│                                 │  Oriented to:    │
│         Main Canvas             │  [domain badge]  │
│      (graph or document)        │  ─────────────   │
│                                 │  [messages]      │
│                                 │                  │
│                                 │  [input + send]  │
└─────────────────────────────────┴──────────────────┘
```

**Column proportions:** Canvas 65%, chat panel 35%. Fixed split — no drag-to-resize in this iteration.

**Canvas toggle:** A two-segment control (`Graph` | `Document`) in the canvas header switches the active view. State is local to the session (not persisted).

**Chat panel:** Always visible regardless of which canvas view is active.

**Tablet (`768px–1024px`):** Same split maintained. The page list sidebar in Document view auto-collapses to an icon strip to recover horizontal space.

**Below `768px`:** Renders a centered placeholder: `Monitor` icon + "The wiki is not available on mobile. Please use a desktop or tablet."

---

## 6. Graph View

### Rendering

D3 force simulation over the `GET /api/v1/wiki/graph` response. The endpoint returns the same `{ nodes, edges }` shape as `LlmWiki.buildGraph()`, merged across all domains. Nodes are positioned by the force layout; edges are SVG lines with arrow markers.

The graph is interactive: drag nodes, zoom, pan.

### Node Appearance

| Attribute | Encoding |
|---|---|
| Domain | Fill color — each domain gets a distinct hue from the domain filter legend |
| Page type | Shape or border style (entity, concept, comparison, query, summary) |
| `contested: true` | Dashed border |
| Edge count | Node radius — more connected nodes render larger |

### Edge Appearance

| Type | Style |
|---|---|
| `references` | Solid line |
| `contradicts` | Red dashed line |
| `derived_from` | Hidden by default; opt-in toggle in the toolbar (source relationships are noisy at scale) |

### Domain Filter

A toolbar above the graph lists all domains with a checkbox per domain. The legend doubles as the filter — unchecking a domain removes its nodes and all edges that cross into it from other domains.

### Node Interaction

Clicking a node opens a hover card showing: page title, type, domain, tags, confidence level. An "Open in editor" button on the hover card switches the canvas to Document view and loads that page in the editor.

### Excluded Content

Schema, log, and index files are never included — filtered server-side in the graph endpoint before the response is sent.

### Refresh

The graph refetches `GET /api/v1/wiki/graph` when a `wiki_updated` SSE event arrives on the ingestion thread. A subtle loading indicator in the toolbar shows a refresh is in progress.

---

## 7. Document View

### Layout

Two sub-columns within the main canvas: a page list sidebar (~220px fixed) and the editor area (remaining width).

### Page List Sidebar

- Domain selector dropdown at the top, populated from `GET /api/v1/wiki/domains`
- Lists all content pages for the selected domain, grouped by type: Entities, Concepts, Comparisons, Queries, Summaries
- Active page is highlighted
- `+` button at the top opens the New Page form (see below)
- On tablet, collapses to an icon strip; tapping the strip expands it as an overlay panel
- Refreshes on `wiki_updated` SSE event

### Editor Area

Loads a page via `GET /api/v1/wiki/domains/:id/pages/*` when selected from the sidebar or navigated to from a graph node's "Open in editor" action.

**Header:** Page title, type badge, domain name, tags, confidence indicator.

**Toggle:** `[Edit | Preview]` control in the editor header.

- **Edit mode:** Raw markdown textarea. CodeMirror with markdown syntax highlighting is the preferred implementation if adding a lightweight dependency is acceptable; a plain `<textarea>` is the fallback.
- **Preview mode:** Renders the markdown body using the existing `markdown.tsx` component. `[[wikilinks]]` render as clickable links that load the target page in the editor.

**Save:** A Save button is visible in Edit mode. On click, the edited content is sent to the ingestion chat as a prefilled message (e.g. `"Update [page title]:\n\n<content>"`). The chat panel receives focus so the user can see the agent processing the request. The page content reloads from the API once the `wiki_updated` SSE event arrives.

### New Page Form

The `+` button in the sidebar opens a small inline form: title (text), type (select: entity/concept/comparison/query/summary), and optional initial content (textarea). Submitting sends a structured message to the ingestion agent in the same way as a save.

---

## 8. Ingestion Chat

### Thread Type

A dedicated wiki-ingestion thread using the same `SqliteSaver` infrastructure as Thread Type 1. A "New conversation" button in the chat panel footer starts a fresh thread and clears the orientation state.

The thread is persisted — returning to `/wiki` resumes the last ingestion thread, matching the existing thread behavior in the main chat UI.

### System Prompt

Focused solely on wiki building. Key behavioral directives:

- The agent's only job is to help the user build, organize, and maintain the wiki
- Always orient to a domain before making changes (`wiki_orient` before any write)
- Prefer updating existing pages over creating new ones when content overlaps
- Lint the affected domain after a batch of writes
- Never discuss topics unrelated to wiki maintenance in this interface

The system prompt is defined in a new `wiki-ingestion-system-prompt.ts` alongside the existing `system-prompt.ts`, following the same `HARNESS_SECTIONS` pattern.

### Tool Set

Only wiki tools are registered for the ingestion agent:

- `wiki_locate`
- `wiki_orient`
- `wiki_search`
- `wiki_read_page`
- `wiki_create_page`
- `wiki_update_page`
- `wiki_add_cross_link`
- `wiki_lint`
- `wiki_register_domain`
- `ask_user` — retained so the agent can ask clarifying questions before committing

`upload_image` is excluded. URL/document ingestion tools are wired in when the Web/URL Ingestion Tool item is implemented.

### Orientation Indicator

When the agent calls `wiki_orient`, the API emits a new `wiki_oriented` SSE event carrying the `wikiId`. The chat panel header renders this as a `BookOpen` icon + domain name chip (e.g. `Oriented to: health-fitness`).

The indicator is blank at the start of a new thread. It clears when the user starts a new thread. Its purpose is to signal to the user which domain the agent is currently working in — anything added or modified in this thread will be evaluated against that domain.

### Domain Creation Form

A `+ New Domain` button in the chat panel header opens a small form:
- Domain name (text, becomes the `wikiId`)
- Description (text, used for routing notes)
- Initial routing notes (textarea, optional)

Submitting the form sends a structured message to the ingestion agent (e.g. `"Create a new wiki domain: [name]. Description: [description]. Routing notes: [notes]."`). The agent processes it via `WikiRegistry.create()` for new domains or `wiki_register_domain` for existing on-disk directories.

### URL & Document Affordances (Stubbed)

The chat input area includes:
- A paperclip icon for file attachment
- A link icon for URL input

Both render visually but display a "coming soon" tooltip on interaction. No backend is wired. When the Web/URL Ingestion Tool item is implemented, these affordances connect to the `web_fetch` / `wiki_ingest` tools with no layout changes required.

---

## 9. Data Flow Summary

**Reading a page:**
UI → `GET /api/v1/wiki/domains/:id/pages/*` → wiki service reads disk → response

**Editing a page:**
User edits in editor → clicks Save → prefilled message sent to ingestion thread → agent calls `wiki_orient` (if not oriented) → agent calls `wiki_update_page` → service commits to disk → `wiki_updated` SSE event → UI refetches page + graph + page list

**Creating a page:**
User submits New Page form → prefilled message sent to ingestion thread → agent calls `wiki_create_page` → service commits to disk → `wiki_updated` SSE event → UI refetches page list + graph

**Creating a domain:**
User submits New Domain form → structured message sent to ingestion thread → agent calls `WikiRegistry.create()` or `wiki_register_domain` → `wiki_updated` SSE event → domain list refreshes across sidebar dropdown and graph filter

**Orientation tracking:**
Agent calls `wiki_orient` → API emits `wiki_oriented` SSE event → UI updates orientation badge in chat header

**Graph refresh:**
`wiki_updated` SSE event arrives → UI calls `GET /api/v1/wiki/graph` → graph re-renders with updated nodes/edges

---

## 10. New SSE Event

Add `wiki_oriented` to the `ChatSSEEventSchema` discriminated union in `lib/llm-common-types/src/chat/sse-events.ts`:

```typescript
{ type: 'wiki_oriented', wikiId: string, wikiName: string }
```

Emitted **immediately and inline** within the current turn by the `wiki_orient` tool after a successful `LlmWiki.orient()` call — the same approach as `wiki_updated` from the direct write tools (`wiki_create_page`, `wiki_update_page`). It is not queued through AfterAgent. This ensures the orientation badge updates in real-time as the agent orients, not at the start of the next turn.

---

## 11. Files Touched (Expected)

**New files:**
- `ui/src/pages/wiki-view.tsx` — top-level wiki page component
- `ui/src/components/wiki/graph-view.tsx` — D3 graph canvas
- `ui/src/components/wiki/document-view.tsx` — page list + editor
- `ui/src/components/wiki/ingestion-chat.tsx` — chat panel
- `ui/src/components/wiki/domain-filter.tsx` — graph domain filter toolbar
- `ui/src/components/wiki/orientation-badge.tsx` — orientation indicator chip
- `ui/src/components/wiki/new-domain-form.tsx` — domain creation form
- `ui/src/hooks/use-wiki.ts` — signals/hooks for wiki state (domain list, graph data, active page)
- `ui/src/services/wiki-api.ts` — client functions for the new REST endpoints
- `api/src/routes/wiki.ts` — new REST route handlers
- `api/src/agents/wiki-ingestion-agent.ts` — wiki-ingestion agent factory
- `api/src/agents/wiki-ingestion-system-prompt.ts` — system prompt for the ingestion agent

**Modified files:**
- `ui/src/app.tsx` — add `wouter` router, `/wiki` route, nav bar icon
- `ui/src/components/layout.tsx` — nav bar active state
- `api/src/index.ts` — register new wiki routes
- `lib/llm-common-types/src/chat/sse-events.ts` — add `wiki_oriented` event type
