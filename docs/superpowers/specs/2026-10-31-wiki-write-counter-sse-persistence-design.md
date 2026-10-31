# Wiki-Write Counter SSE Persistence — Design

Fixes [#363](https://github.com/tkottke90/amazing-hashbrown/issues/363): `wikiWriteCount` reads 0 in workspace retrospectives even when a run's own summary confirms a successful wiki save. The `wiki_mismatch` anomaly check has the same defect for the same reason.

See `GLOSSARY.md`'s "Live SSE Events" section for **Active SSE Writer**, **Persisted Event**, **Streamed-Only Event**, **Wiki Update Event**, and **Wiki Update Message** — this spec doesn't restate those definitions. See `docs/adr/0047-shared-persister-registry-for-live-sse-events.md` for why the fix is a shared registry rather than a second inline special case per sink. See `GLOSSARY.md`'s "AfterAgent & Wiki Write Scope" section for **Wiki Domain** — this fix is uniform across every Wiki Domain, including `self`; nothing here is domain-specific.

## New module: `api/src/agents/persisted-sse-events.ts`

- `PERSISTERS`: a `Partial<Record<ChatSSEEvent['type'], Persister>>` map, where `Persister = (event, threadStore, threadId) => number | null`. Two entries to start:
  - `resource_created` → calls `recordResourceCard` with `randomUUID()` and the event's `resourceType`/`name`/`goal`/`location`/`workspaceId`, moved here from `makeLiveSseWriter`.
  - `wiki_updated` → calls `recordWikiUpdate` with `randomUUID()` and the event's `pageTitle`/`pageKind`/`wikiName`/`path` — the missing entry that is this issue's actual fix.
- `persistSseEvent(event, threadStore, threadId): ChatSSEEvent`: if `event.seq` is already set, return it unchanged (an event drained and persisted by `drainAndRecordWikiUpdates` before reaching here must not be persisted a second time). Otherwise look up `PERSISTERS[event.type]`; no entry → return `event` unchanged (a Streamed-Only Event). An entry → call it, return `seq !== null ? { ...event, seq } : event`. No new try/catch here: `recordResourceCard`/`recordWikiUpdate` already swallow their own errors via `thread-message-writer.ts`'s existing `safe()` wrapper (log and return `null`), so a persistence failure already degrades to "this one write goes uncounted" rather than failing the triggering tool call or turn.
- `applyPersistedSseEvents(writer: SseWriter, threadStore: ThreadStore, threadId: string): SseWriter`: returns `(event) => writer(persistSseEvent(event, threadStore, threadId))`. This is the one thing every Active SSE Writer wraps itself in.

Adding a third Persisted Event type later means adding one `PERSISTERS` entry — no sink changes.

## Updating the four Active SSE Writer sites

1. **`api/src/agents/stream-handler.ts`, `makeLiveSseWriter`**: delete the inline `if (event.type === 'resource_created')` branch and its comment; return `applyPersistedSseEvents(rawWrite, threadStore, threadId)` instead of the hand-rolled closure.
2. **`api/src/agents/stream-handler.ts`, `drainAndRecordWikiUpdates`**: unchanged — it already calls `recordWikiUpdate` itself and sets `event.seq` before forwarding to `sink`, which is exactly what makes the `persistSseEvent` already-has-`seq` guard above necessary (its caller passes the now-wrapped `sink`).
3. **`api/src/agents/workspace-chat-stream-handler.ts`** (three turn variants, `~151-153`, `~398-400`, `~615-617`): each currently defines `const sink: SseWriter = (event) => { res.write(...) }` then calls `setActiveSseWriter(threadId, sink, controller)`. Wrap it: `const sink = applyPersistedSseEvents((event) => { res.write(...) }, threadStore, threadId);` — `threadStore` is already in scope at each site (`getThreadStore()`).
4. **`api/src/agents/wiki-stream-handler.ts`** (same `res.write` pattern at `~102`, `~260`, `~413`): same change — wrap the raw `res.write` closure before `setActiveSseWriter`.
5. **`api/src/agents/task-execution.ts`** (`~377-380`): the `previousWriter?.(event)` forwarding sink becomes `applyPersistedSseEvents((event) => { previousWriter?.(event); }, threadStore, threadId)`. This is the scenario the issue's root cause actually depends on most: a scheduler-triggered run has no `previousWriter`, so today the event (and any count of it) is dropped entirely. After this change, persistence happens before the (possibly no-op) forward, so a scheduled run's direct wiki writes get counted too.

No change to `queueWikiUpdate`/`after-agent.ts` — that path was never broken.

## Updating the regression test that locked this in

`api/src/agents/stream-handler.test.ts:147-154` currently asserts `makeLiveSseWriter` passes every non-`resource_created` event through "unchanged (regression guard)," using `wiki_domain_created` as its example — which incidentally also covered, and locked in, `wiki_updated`'s missing persistence. Narrow it: keep the passthrough assertion for `wiki_domain_created` (still a true Streamed-Only Event), and add a separate assertion that `wiki_updated` now persists (a `wiki_update` row appears, and the written event carries `seq`) the same way `resource_created` already does.

## Out of scope

- No backfill of historical retrospectives (e.g. the gmail-labeler one from 2026-10-26) — forward-looking only.
- No change to `wikiWriteCount`'s or `wiki_mismatch`'s own counting/aggregation logic in `lib/thread-reports` or `lib/workspace-reports` — both already read `wiki_update` rows correctly; the defect was entirely upstream, in rows never being written.
- No eval scenario — this is deterministic application code, not LLM-facing behavior.

## Testing

Per the root `AGENTS.md` testing rules, all of the following ship in the same PR:

- **Unit**: `persisted-sse-events.test.ts` — `persistSseEvent` persists a `resource_created` and a `wiki_updated` event and attaches `seq`; returns a Streamed-Only Event (e.g. `wiki_domain_created`) unchanged; returns an event that already carries `seq` unchanged without calling any persister (spy, not a real store call). `applyPersistedSseEvents` forwards the persisted (or unchanged) event to the wrapped writer exactly once.
- **Unit**: `stream-handler.test.ts` — narrowed regression test per above; `makeLiveSseWriter` now delegates to `applyPersistedSseEvents` (spy-based, not re-testing persistence logic already covered by `persisted-sse-events.test.ts`).
- **Orchestration** (one per sink, proving the real gap closes): `workspace-chat-stream-handler.test.ts`, `wiki-stream-handler.test.ts`, `task-execution.test.ts` — each drives a real `wiki_create_page`/`wiki_update_page` tool call through that sink's registered Active SSE Writer and asserts a `wiki_update` row lands in the thread store. The `task-execution.test.ts` case specifically covers the no-live-client (`previousWriter` undefined) scenario, since that's the one existing tests never exercised.
- **Orchestration**: `lib/thread-reports` and `lib/workspace-reports`'s existing `build.test.ts` suites already prove the aggregation math is correct once `wiki_update` rows exist — no new test needed there, but worth a quick confirming run since this fix is what finally makes that math reachable end-to-end from a real tool call.
