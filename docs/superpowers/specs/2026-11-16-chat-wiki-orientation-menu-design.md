# Chat-Input Wiki Orientation Menu — Design

Today the only way a conversation gets oriented to a Wiki Domain is the `wiki_orient` tool (`api/src/agents/tools/wiki-orient.tool.ts`), which the agent calls either because the user asked in plain language or because it inferred the need itself. There is no mechanical, agent-independent way for the user to pick a wiki — and even when the agent does orient, its own prose response afterward tends to restate the tool's full schema/index/log dump back into the chat.

This adds a new "Orient to wiki" menu item (with a nested wiki list, mirroring the existing "Provider" submenu) to the chat-input "+" menu, on every chat surface that has one. Selecting a wiki never invokes the model — it's a direct, mechanical action that still makes the agent genuinely aware of that wiki's content on every subsequent turn, and surfaces only a small, static confirmation card in the chat timeline, never a generated summary.

See `GLOSSARY.md`'s existing "Wiki Domain" section for that term; this design introduces a new, related term — **Wiki Orientation** (a thread's single, currently-active Wiki Domain for ambient context, set mechanically via this menu or implicitly by the agent's own `wiki_orient` tool calls, which this design doesn't change) — worth a short new GLOSSARY.md section at implementation time, alongside "Wiki Reference" and "Wiki Domain."

## Scope

Wired into the three chat surfaces that render `ChatInput` today: plain/global chat (`ui/src/pages/chat/index.tsx`), workspace chat (`ui/src/pages/workspaces/workspace-chat-tab.tsx`), and the wiki-ingestion chat (`ui/src/pages/wiki/ingestion-chat.tsx`). On the backend, the mechanism that makes the agent aware of the active wiki (see "Server: making the agent aware" below) is added to `buildChatAgent`, `buildWorkspaceChatAgent`, and `buildWikiIngestionAgent`'s middleware arrays, and to `buildTaskAgent`'s for the same "stay in lockstep" reason other middleware rides along there (`chat-agent.ts:1063` middleware array) even though task-run threads have no composer to trigger it from. `buildSubAgentAgent` is excluded — it already builds its middleware from a separate `buildSubAgentMiddleware(...)` call (`chat-agent.ts:1307`), not the shared array literal, matching the precedent set by `docs/superpowers/specs/2026-11-01-wiki-reference-chat-staging-design.md`'s own exclusion of sub-agent threads.

## Client: the menu

**`ui/src/components/chat-input.tsx`**: new `ChatInputProps` fields, alongside the existing `providers`/`favoriteModels` (`:122-127`): `wikiDomains?: WikiDomain[]`, `activeWikiId?: string | null`, `onOrientToWiki?: (wikiId: string) => void`, `onClearWikiOrientation?: () => void`. A new `DropdownMenuSub` added after the "Provider" sub (`:889-924`), rendered only when `wikiDomains && wikiDomains.length > 0`:

- `DropdownMenuSubTrigger`: "Orient to wiki".
- `DropdownMenuSubContent`: one `DropdownMenuItem` per domain, label `domain.id`, a `title` attribute (native tooltip) of `domain.domain` (the short description already returned by `GET /api/v1/wiki/domains` — see `ui/src/services/wiki-api.ts:5-9`'s `WikiDomain` interface), a trailing checkmark icon when `domain.id === activeWikiId`, `onSelect={() => onOrientToWiki?.(domain.id)}`.
- When `activeWikiId` is set: a `DropdownMenuSeparator` then one more item, "Clear wiki orientation", `onSelect={() => onClearWikiOrientation?.()}`.

Unlike the Provider sub, this one does **not** need the controlled-open/close-grace-timer machinery (`providerMenuOpen`, `childMenuOpen`, `scheduleProviderMenuClose`, etc., `:429-492`) — that machinery exists specifically because a provider's model list is a separately-portaled subtree underneath it (`:470-482`). The wiki list has no further nested portal, so a plain, Radix-default-uncontrolled `DropdownMenuSub` is correct here; copying the Provider sub's open-state choreography would be unnecessary complexity for a flat list.

## Client: supplying the domain list and tracking the active wiki

**New hook, `ui/src/hooks/use-wiki-domains.ts`** (used by 2+ pages, per `ui/AGENTS.md`'s "Where does this file go?"): wraps `fetchDomains()` (`wiki-api.ts:52-56`) behind a `domains` signal fetched once on first use, for `chat/index.tsx` and `workspace-chat-tab.tsx` to pass as `wikiDomains`. `ingestion-chat.tsx` keeps using its existing `domains`/`refreshDomains` from `pages/wiki/use-wiki.ts` (already fetched there for the Wiki page's own domain picker) and threads that into the same `wikiDomains` prop — no need to duplicate a fetch that page already makes.

**Active-wiki display state**: `ThreadInstanceOptions` (`use-thread.ts:191-206`) already has a generic `onWikiOriented?: (evt: WikiOrientedEvent) => void` callback, today wired only by `use-wiki-ingestion.ts:72-74`'s `wikiOrientedTo` signal. `chat/index.tsx` and `workspace-chat-tab.tsx` each gain their own equivalent local signal and wire it the same way, so the menu's checkmark works on every surface, not just the wiki page.

`ThreadInstance`'s `hydrate()` (whatever reads `GET /api/v1/threads/:id` into the thread's local state) also seeds that same display signal from the new `activeWikiId` field on the thread summary response (see "Server: schema" below) — otherwise reopening a thread would show no checkmark at all until the next live orientation event, even though the server-persisted state says otherwise.

**Wiring the menu's actions**: `onOrientToWiki(wikiId)` calls `POST /api/v1/threads/:id/wiki-orientation` with `{ wikiId }`; `onClearWikiOrientation()` calls `POST /api/v1/threads/:id/wiki-orientation/clear`. Both are plain REST calls, not SSE — there is no agent turn running when the user clicks this menu item, so there's nothing for `getActiveSseWriter` (the mechanism `wiki-orient.tool.ts:57` uses to push its own live `wiki_oriented` event) to attach to. Each call's JSON response carries the persisted `ThreadMessageRecord` the server just inserted (see below); the caller appends it straight into `messages.value`, the same optimistic-append idiom `use-thread.ts`'s `sendMessage` already uses for the local user bubble, and updates the local active-wiki display signal to match.

## Client: the confirmation card

**`ui/src/types/thread-message.ts`**: new `ThreadMessage` variant, alongside `'wiki_update'` (`:121-131`):

```ts
{
  kind: 'wiki_orientation';
  id: string;
  seq?: number;
  wikiId: string;
  wikiDescription: string;
  action: 'set' | 'cleared';
  createdAt: string;
}
```

**New component, `ui/src/components/wiki-orientation-message.tsx`**, modeled on `wiki-update-message.tsx` minus its interactive buttons (this card has nothing to click): `ThreadCardShell` + a `BookOpen` icon + `CardBadge` for the wiki id. For `action: 'set'`, shows the id and `wikiDescription` ("📘 Oriented to wiki — *user* — user preferences, personal context, and biography"); for `'cleared'`, a single muted line ("No longer oriented to a wiki"). Never anything more than that — no schema/index/log content, matching Q9's "name + description only."

**`ui/src/components/thread-message.tsx`**: new `case 'wiki_orientation': return <WikiOrientationMessage message={message} />;` alongside the existing `'wiki_update'` case (`:89-96`).

## Server: schema

**`api/src/services/thread-store.ts`**: one new migration (no 3-step NOT-NULL dance needed — unlike the `type` column (`:199-227`), this one stays nullable, so a single step suffices):

```ts
{
  version: 44, // next after the existing highest, version: 43 (archived_at)
  sql: `ALTER TABLE threads ADD COLUMN active_wiki_id TEXT`,
},
```

`ThreadSummary` (`:13-33`), `RawThreadRow` (`:77-89`), and `mapThreadRow` (`:110-124`) each gain `activeWikiId: string | null` / `active_wiki_id`. New method, mirroring `updateThreadModel`'s shape exactly (`:647-651`):

```ts
setActiveWikiId(threadId: string, wikiId: string | null): void {
  this.db
    .prepare(`UPDATE threads SET active_wiki_id = ? WHERE id = ?`)
    .run(wikiId, threadId);
}
```

Deliberately does **not** touch `updated_at` — orienting to a wiki isn't conversation activity any more than a tool-selection change is, matching `markThreadToolsCustomized`/`resetThreadToolsCustomization`'s reasoning (`:658-668`) rather than `updateThreadModel`'s (which does bump it); it shouldn't reorder a thread in the sidebar.

## Server: the routes

**`api/src/routes/v1/threads.route.ts`**: two new routes, named as a POST-subpath pair the same way `archive`/`unarchive` already are (`:140,155`), rather than mixing in a DELETE verb:

```ts
threadsRouter.post('/:id/wiki-orientation', async (req, res) => { ... });
threadsRouter.post('/:id/wiki-orientation/clear', async (req, res) => { ... });
```

Each extracts a plain, Express-agnostic handler per the root `AGENTS.md`/`api/AGENTS.md` testing rule (no `Request`/`Response` types, `HandlerResult<T>` out), added to `api/src/routes/v1/threads.handlers.ts` alongside `renameThreadHandler`:

- **`setWikiOrientationHandler(store, registry, threadId, wikiId)`**: 404 if the thread doesn't exist (reusing whatever existing thread-lookup `threads.handlers.ts`'s other endpoints already use for that check); 404 if `registry.load(wikiId)` throws (unknown domain — same failure `wiki-orient.tool.ts:48-52` already handles for the agent-triggered path, mirrored here for the mechanical one). On success: `store.setActiveWikiId(threadId, wikiId)`, then inserts and returns a `wiki_orientation`/`set` message (new `recordWikiOrientation` helper in `thread-message-writer.ts`, mirroring `recordWikiUpdate`'s shape at `:320-336`) carrying the wiki's `domain` field (the short description already on the loaded `WikiDomain`/registry entry — no need to call `wiki.orient()` here at all; that full schema/index/log fetch happens separately, fresh, inside the middleware below, not at selection time).
- **`clearWikiOrientationHandler(store, threadId)`**: 404 if the thread doesn't exist; otherwise `store.setActiveWikiId(threadId, null)`, inserts and returns a `wiki_orientation`/`cleared` message.

## Server: making the agent aware

This is the part that actually satisfies "the agent should behave as if it had called `wiki_orient` itself" without an LLM turn. The key constraint: `getChatAgent`/`getWikiIngestionAgent`(`chat-agent.ts:944-953`, `wiki-ingestion-agent.ts:85-96`) cache their compiled agent **per provider:model only**, shared across every plain-chat/wiki-chat thread — there is no per-thread system prompt for those two surfaces the way `getWorkspaceChatAgent` already has per-workspace (`chat-agent.ts:911-926`). So baking the active wiki's content into a cached system-prompt string (the way `buildWorkspaceContextBlock` does for a workspace's bound wiki, `chat-agent.ts:784-836`) would require restructuring that cache to be per-thread for two builders that don't need it for anything else today — a bigger, riskier change than this feature calls for, and the wrong tool for a value that must already be fresh every turn.

The codebase already has the right tool for exactly this: `ambient-context.middleware.ts`'s `wrapModelCall`, which rewrites the system message **fresh on every model call**, regardless of how long the parent agent has been cached (see its own header comment, `:7-12`) — and `tool-access.middleware.ts:63-64`'s established way to read the current thread id inside `wrapModelCall` (`request.runtime.configurable?.thread_id`, citing the same `Runtime.configurable?.thread_id` typing `afterAgentMiddleware` already relies on).

**New file, `api/src/agents/wiki-orientation-context.middleware.ts`**:

```ts
export const wikiOrientationContextMiddleware = createMiddleware({
  name: 'WikiOrientationContextMiddleware',
  wrapModelCall: async (request, handler) => {
    const threadId = request.runtime.configurable?.thread_id;
    const activeWikiId = threadId ? getThreadStore().getThread(threadId)?.activeWikiId : null;
    if (!activeWikiId) return handler(request);

    try {
      const registry = await getWikiRegistry();
      const wiki = await registry.load(activeWikiId);
      const { schema, index, recentLog } = await wiki.orient();
      const block = formatWikiOrientation(activeWikiId, schema, index, recentLog);
      const baseContent = getMessageText(request.systemMessage.content);
      return handler({
        ...request,
        systemMessage: new SystemMessage(`${baseContent}\n\n${block}`),
      });
    } catch {
      // The stored activeWikiId's domain no longer resolves (e.g. deleted
      // after being set active) — degrade silently rather than failing the
      // turn; same posture as every other best-effort context addition here.
      return handler(request);
    }
  },
});
```

`formatWikiOrientation` is `wiki-orient.tool.ts`'s existing `[...].join('\n')` block (`:62-73`, including `truncateIndex`, `:19-36`) extracted into a shared, exported function — imported by both the tool (unchanged behavior, confirmed by its existing tests) and this new middleware, so the two paths produce byte-identical orientation text instead of two copies that can drift apart. This is also what makes "the agent behaves as if it had called the tool" literally true rather than approximate: same formatter, same data, just delivered as a per-turn system-prompt addition instead of a tool result.

Added to the middleware array, near `ambientContextMiddleware`, in `buildChatAgent` (`:695-725`), `buildWorkspaceChatAgent` (`:876-901`), `buildTaskAgent` (`:1063-1105`), and `buildWikiIngestionAgent` (`wiki-ingestion-agent.ts:64-77`).

**Why this also makes "replace" and "clear" fully clean, for free**: since nothing is ever written into permanent message/checkpoint history, switching `active_wiki_id` from one wiki to another, or to `null`, changes what the very next model call sees with zero residue and no explicit "disregard the old one" marker needed — the old content simply isn't re-added. (This is a deliberate simplification versus the `workspace-summarizer.ts`/`updateState()`/checkpoint-boundary-marker pattern surfaced during design — that pattern exists to help `boundaryAwareTrim` cut old messages cleanly *after* a summary supersedes them; there's no equivalent "old content needs to be trimmed away" problem here, since nothing is added to history in the first place. No `agent.graph.updateState()` call, and no new checkpoint-boundary-marker type, are needed for this feature.)

**Performance note**: this calls `wiki.orient()` (schema/index/recent-log file reads) on every model call for a thread with an active wiki, versus once per explicit tool call today. Accepted as-is for a local, modest-sized knowledge base; a short-TTL in-process cache is a reasonable follow-up if this proves slow in practice, not pursued here.

## Checkmark sync across sources, and its honest limitation

The self-triggered `wiki_orient` tool already emits a `wiki_oriented` SSE event (`wiki-orient.tool.ts:57`) purely as a UI side effect; this design doesn't change that. With `onWikiOriented` now wired on every surface (not just the wiki page), the menu's checkmark reflects whichever source — the mechanical REST response or a live self-triggered SSE event — fired most recently, within one live session. `active_wiki_id` itself is written only by the mechanical path (`setWikiOrientationHandler`/`clearWikiOrientationHandler`); the self-triggered tool call never touches it, deliberately (see "Out of scope").

This has one honest gap, worth stating in the UI rather than hiding: after a page reload, the only surviving source is the persisted `activeWikiId` from the thread's hydrate response — a self-triggered orientation that happened live but was never mechanically set reverts to showing no checkmark once the session's SSE memory is gone. And "Clear wiki orientation" only ever controls the mechanical, per-turn-reinjected content; it has no way to reach into message history the agent already permanently wrote there on its own via a real tool call. The "Clear wiki orientation" menu item should carry a tooltip saying as much.

## Out of scope

- Writing `active_wiki_id` from the self-triggered `wiki_orient` tool call. Keeping the two paths independent was a deliberate choice (grilling round, Q10) to avoid scope creep into the agent's own tool/prompt behavior; the resulting checkmark/reload limitation above is accepted, not silently patched around.
- Any project/workspace scoping of the wiki list shown in the submenu — Wiki Domains are global today (`GET /api/v1/wiki/domains` returns `registry.list()` unfiltered); this design doesn't add scoping.
- Live-pushing the confirmation card to a second browser tab open on the same thread — the REST response updates only the client that made the call; another open tab sees the card on its next hydrate.
- Any eval suite changes — this is deterministic plumbing (a REST call, a DB column, string formatting already covered by `wiki-orient.tool.ts`'s own tests), not new LLM-facing judgment. Whether the model makes good use of injected wiki context is already covered by the existing wiki-navigation/wiki-search suites, which exercise the same formatted block via the tool path.
- A cache for the middleware's per-turn `wiki.orient()` call — noted as a possible follow-up only.

## Testing

Per the root `AGENTS.md`, all ship in the same PR:

- **Unit**: `chat-input.test.tsx` — the "Orient to wiki" submenu renders one item per `wikiDomains` entry; the active one shows a checkmark; selecting an item calls `onOrientToWiki` with its id; "Clear wiki orientation" renders only when `activeWikiId` is set and calls `onClearWikiOrientation`; the submenu is absent entirely when `wikiDomains` is empty/undefined.
- **Unit**: `wiki-orientation-message.test.tsx` — `action: 'set'` renders the wiki id and description; `action: 'cleared'` renders the muted no-longer-oriented line; neither ever renders schema/index/log content.
- **Unit**: `thread-message.test.tsx` — the `'wiki_orientation'` case renders `WikiOrientationMessage`.
- **Unit**: `thread-store.test.ts` — `setActiveWikiId` persists and round-trips through `getThread`/`mapThreadRow`; the new migration leaves existing rows' `active_wiki_id` as `NULL` without erroring; `setActiveWikiId` does not change `updated_at`.
- **Unit**: `thread-message-writer.test.ts` — the new `recordWikiOrientation` helper inserts the right `kind`/`payload` for both `'set'` and `'cleared'`.
- **Unit**: `wiki-orient.tool.test.ts` — still passes unchanged against the extracted `formatWikiOrientation` helper (pure refactor, confirms no behavior change to the existing tool).
- **Unit**: `wiki-orientation-context.middleware.test.ts` — no-op (system message untouched) when `configurable.thread_id` is absent or the thread has no `activeWikiId`; appends `formatWikiOrientation`'s block when it does; degrades silently (no-op, doesn't throw or fail the turn) when the stored `activeWikiId` no longer resolves to a real domain.
- **Orchestration**: `threads.handlers.test.ts` — `setWikiOrientationHandler` 404s on an unknown thread and on an unknown `wikiId`; on success persists `active_wiki_id` and inserts/returns a `'set'` card; `clearWikiOrientationHandler` 404s on an unknown thread; on success nulls `active_wiki_id` and inserts/returns a `'cleared'` card.
- **Orchestration**: `threads.route.test.ts` — the two new routes extract `id`/body correctly and call the right handler (spy), not re-testing handler logic already covered above.
