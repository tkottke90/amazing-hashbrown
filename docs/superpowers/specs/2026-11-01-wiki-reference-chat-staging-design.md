# Wiki Reference Chat Staging — Design

Today, the only way a wiki page already surfaced in a thread (via a Wiki Update Message card) gets back in front of the model is by the agent inferring it should call `wiki_search`/`wiki_read_page` again. This adds an explicit alternative: an `Add to Message` button on the Wiki Update Message card that stages a Wiki Reference — the user names the page, the system carries its content into that turn, no tool call or inference required.

See `GLOSSARY.md`'s new "Wiki References in Chat" section for **Wiki Reference**, and `docs/adr/0055-wiki-references-resolve-lazily-like-skills-not-attachments.md` for why resolution is lazy (skill-style) rather than eager (attachment-style) — this spec doesn't restate either. See `GLOSSARY.md`'s "AfterAgent & Wiki Write Scope" section for **Wiki Domain**, and its "Live SSE Events" section for **Wiki Update Message**.

## Scope

Wired into the three chat surfaces that already accept `attachmentIds` and register `attachmentAwarenessMiddleware`: main chat (`chat.route.ts` / `buildChatAgent`), workspace chat (`workspace-chat.route.ts` / `buildWorkspaceChatAgent`), and the wiki-ingestion chat (`wiki.route.ts` / `buildWikiIngestionAgent`). `buildTaskAgent` gets the middleware too, for the same "stay in lockstep across builders" reason `attachmentAwarenessMiddleware` already rides along there (`chat-agent.ts:901`) even though task-run threads have no composer to stage anything from. `buildSubAgentAgent` is excluded, matching that it carries neither `attachmentAwarenessMiddleware` nor `createSkillExpansionMiddleware` today.

## Client: staging

**`ui/src/components/wiki-update-message.tsx`**: add a second button next to the existing `Open` button (`:32-46`), gated on the same `message.path` guard. New prop on `WikiUpdateMessageProps` (`:7-9`): `onStageWikiReference?: (ref: StagedWikiReference) => void` and `isStaged?: boolean`. Clicking calls `onStageWikiReference({ wikiId: message.wikiName, path: message.path, title: message.pageTitle })`; while `isStaged` is true the button renders in an "Added" state (checkmark, disabled) instead of re-firing. No network call here — this button never reads the page, it only stages the identifying tuple.

**`ui/src/components/thread-message.tsx`**: `ThreadMessageItemProps` (`:14-22`) gains `onStageWikiReference?: (ref: StagedWikiReference) => void` and `stagedWikiReferenceKeys?: Set<string>` (keyed `` `${wikiId}:${path}` ``), threaded to the `wiki_update` case (`:77-78`) the same way `onFork`/`onRetry` already thread to other cases — no new global signal; this follows the existing callback-prop pattern, not `toasts`' app-wide-signal pattern, since staging is scoped to one composer, not the whole app.

**`ui/src/components/chat-input.tsx`**: new exported type `StagedWikiReference = { wikiId: string; path: string; title: string }`, alongside `StagedAttachment` (`:46`). New `ChatInputProps` fields mirroring `attachments`/`onAttachmentsChange` (`:95,101`) exactly: `wikiReferences: StagedWikiReference[]` and `onWikiReferencesChange: (refs: StagedWikiReference[]) => void` — same controlled pattern, owned by the caller, cleared to `[]` on send. Rendered as `ChatInputChip`s (`:123`) in the same header row as attachment chips, each with its own remove (×) button. New constant `MAX_WIKI_REFERENCES_PER_MESSAGE = 2`.

**Caps are pooled, not independent** (grilling round 2, Q1 — wiki references count *inside* the existing shared cap, they don't add a separate pool on top of it): `MAX_ATTACHMENTS_PER_MESSAGE` (`:51`) stays the ceiling on `attachments.length + wikiReferences.length` combined, not just on `attachments.length`. Two call sites change to reflect this:

- **Staging a wiki reference** (new function, same file, parallel to `stageFile`/`stageFiles`): given a `StagedWikiReference`, look it up by `wikiId`+`path` in the current `wikiReferences` prop. Already present → no-op, `showToast('error', 'Already added to message')` (`ui/src/lib/toast.ts`). Otherwise, reject (toast, don't add) if `wikiReferences.length >= MAX_WIKI_REFERENCES_PER_MESSAGE` (`'Only 2 wiki pages allowed per message'`) **or** `attachments.length + wikiReferences.length >= MAX_ATTACHMENTS_PER_MESSAGE` (`'Only 4 items allowed per message'`) — either cap alone can block it. Otherwise `onWikiReferencesChange([...wikiReferences, ref])`.
- **Staging a file attachment, `stageFiles`** (`:280-292`): `remainingSlots`, today computed from `MAX_ATTACHMENTS_PER_MESSAGE - attachments.length` alone, becomes `MAX_ATTACHMENTS_PER_MESSAGE - attachments.length - wikiReferences.length` — a staged wiki reference now occupies a slot a file upload would otherwise take. The existing skipped-file message (`` `Only ${MAX_ATTACHMENTS_PER_MESSAGE} attachments allowed per message...` ``) is only exactly accurate when nothing but file attachments contributed to filling the pool; left as today's wording since the grilling session didn't revisit attachment copy, but worth a follow-up polish pass if it reads oddly once wiki references are in the mix.

Both wiki-reference error paths reuse the existing `'error'` toast styling — no new toast variant, no new shadcn component (an earlier assumption that one would be needed doesn't hold: `showToast`/`ToastContainer` already cover this app-wide).

The owning page passes `stagedWikiReferenceKeys` down as `new Set(wikiReferences.map(r => \`${r.wikiId}:${r.path}\`))` so every `WikiUpdateMessage` card in the thread can independently compute its own `isStaged`.

## Client: sending and display

**`ui/src/hooks/use-thread.ts`**, `sendMessage` (`:696-759`): request body (`:742-750`) gains `wikiReferences?: StagedWikiReference[]` alongside `attachmentIds`. The optimistic local user bubble (`:704-728`) renders a chip per staged reference the same way it renders attachment chips, using the client-known `title` — no server round-trip needed to show it, same as attachments' `previewUrl` shortcut.

**`ui/src/types/thread-message.ts`**: the `'user'` kind (`:17-34`) gains `wikiReferences?: UserMessageWikiReference[]`, mirroring `attachments?: (UserMessageAttachment & { previewUrl?: string })[]` (`:33`) — here there's no `previewUrl`-equivalent local-only field, since a Wiki Reference carries no binary preview.

## Server: wire shape and persistence

**New shared type**, `lib/llm-common-types/src/chat/sse-events.ts`, alongside `UserMessageAttachmentSchema` (`:40-50`):

```ts
export const UserMessageWikiReferenceSchema = z.object({
  wikiId: z.string(),
  path: z.string(),
  title: z.string(),
  included: z.boolean().optional(),
  exclusionReason: z.enum(['page_missing']).optional(),
});
export type UserMessageWikiReference = z.infer<typeof UserMessageWikiReferenceSchema>;
```

`included`/`exclusionReason` exist so the persisted record can tell a dropped-at-resolution-time reference apart from one the model actually saw — same reasoning as `UserMessageAttachment`'s own fields, but populated later: not by the route handler (nothing is resolved there), only once the new middleware runs. A page that resolves cleanly leaves `included`/`exclusionReason` as they were at send time (`included` absent) rather than the middleware writing back a success flag — there's no round-trip from the middleware back into `thread_messages` for this; see "Out of scope."

**Routes** (`chat.route.ts:59-74`, `workspace-chat.route.ts:85-97`, `wiki.route.ts:258-269`): each destructures `wikiReferences` alongside `attachmentIds` and adds two checks, matching the pooled-cap rule above rather than treating `wikiReferences` as its own independent pool: `if (wikiReferences && wikiReferences.length > 2) { ... }` (the sub-limit), and `if ((attachmentIds?.length ?? 0) + (wikiReferences?.length ?? 0) > 4) { ... }` (the shared ceiling, replacing the existing standalone `attachmentIds.length > 4` check at each site rather than sitting alongside it unchanged).

**`api/src/agents/thread-message-writer.ts`**, `recordUserMessage` (`:33-40`): new optional parameter `wikiReferences?: UserMessageWikiReference[]`, persisted into the `thread_messages` row's payload alongside `attachments` — no transformation, since nothing has resolved yet at this point; the array is exactly what the client sent.

**`api/src/agents/stream-handler.ts`**, `streamChatToSse` (`:886-938`) and its workspace-chat/wiki-ingestion equivalents: new `wikiReferences?: UserMessageWikiReference[]` parameter, passed straight through — no `resolveWikiReferencesForTurn`-style eager resolution call (that's the whole point of ADR-0055). `config.configurable` (`:927-929`) gains `wikiReferences`, forwarded unresolved; `recordUserMessage` (`:931-938`) gets `wikiReferences` as its new last argument, also unresolved.

## Server: lazy resolution

**New file, `api/src/agents/wiki-reference-expansion.middleware.ts`**, modeled directly on `skill-expansion.middleware.ts` rather than split across an eager-resolution module + a thin apply-middleware (`attachment-resolution.ts` + `attachment-awareness.middleware.ts`) — there is no separate resolution step to extract, because nothing needs resolving before the turn is invoked:

- `beforeAgent`: reads `runtime.configurable?.wikiReferences`; if empty, `return undefined`.
- Finds the turn's last human message exactly as `skill-expansion.middleware.ts` (`:30-41`) and `attachment-awareness.middleware.ts` (`:22-32`) both do.
- For each reference, calls `getWikiRegistry()` then `registry.load(wikiId)` then `wiki.readPage(path)` — the same three calls `wiki-read-page.tool.ts` (`:26-40`) already makes — and builds the same `` `# ${title}\n\nType: ${type}\nTags: ${tags}\n\n${content}` `` string that tool builds (`:42`), but **never truncates** (per the grilling session's Q6: the whole point is the full page, unlike `wiki_read_page`'s own `truncate` default). A page beyond `STUB_THRESHOLD_CHARS` (`tool-stub.ts`, already used by `attachment-resolution.ts:135,145-175` for oversized attachments) is offloaded the same way: `storeToolContent(threadId, toolKey, fullPageText)` plus a `toolStub(...)` summary-and-`get_tool_key`-hint notation, instead of inlining the whole body.
- `wiki.readPage(path)` throwing `ENOENT` (the same error `wiki-read-page.tool.ts:58` already checks for) degrades to a notation — `` `[The user referenced wiki page "${title}" (${wikiId}/${path}) but it no longer exists.]` `` — instead of failing the turn, matching the grilling session's Q7.
- Every reference's resulting text (full page, stub, or missing-page notation) appends to the last human message's text content, each prefixed with an explicit citation line: `` `--- \nWiki Reference — Wiki Domain "${wikiId}", path "${path}":` `` — so the model has the exact identifiers it needs to call `wiki_update_page` on the same page later in the turn.
- Registers **after** whichever of `createSkillExpansionMiddleware`/`attachmentAwarenessMiddleware` a given builder already has, in every builder's `middleware` array: after both, in that order, in `buildChatAgent` (`chat-agent.ts:542,551`), `buildWorkspaceChatAgent` (`:708,712`), and `buildTaskAgent` (`:884,901`); after `attachmentAwarenessMiddleware` alone in `buildWikiIngestionAgent` (`wiki-ingestion-agent.ts:71`), which has no skill-expansion middleware to begin with. Same reasoning as `attachment-awareness.middleware.ts`'s own header comment about running after skill expansion — append onto whatever's already there, never overwrite it.

## Out of scope

- The wiki document-viewer page and wiki search results UI — `Add to Message` is added only to the Wiki Update Message card for this round (grilling Q3). Same underlying mechanism, different trigger point, left as a follow-up.
- Writing the middleware's resolution outcome (success/`page_missing`) back onto the already-persisted `thread_messages` row. Unlike attachments — which resolve before `recordUserMessage` and so can write `included`/`exclusionReason` into the very same insert — a Wiki Reference resolves after persistence, inside the agent's own invocation. Patching the row afterward would need a second write keyed by message id purely for display polish on a past bubble; not pursued here. The bubble shows the reference as staged either way; only the model-facing text reflects whether the page still existed.
- A new `'info'` toast variant — both the cap-reached and duplicate-reference cases reuse the existing `'error'` styling (grilling round 3/4).
- `buildSubAgentAgent` — no composer exists to stage a reference from.

## Testing

Per the root `AGENTS.md` testing rules, all ship in the same PR:

- **Unit**: `wiki-reference-expansion.middleware.test.ts` — no-op when `configurable.wikiReferences` is empty/absent; appends a full, untruncated page's content plus citation line to the last human message for a resolvable reference; offloads to `storeToolContent`/`toolStub` past `STUB_THRESHOLD_CHARS`; degrades to a "no longer exists" notation on `ENOENT`; appends after content already added by a preceding skill-expansion/attachment-awareness rewrite rather than replacing it.
- **Unit**: `chat-input.test.tsx` — staging a new reference calls `onWikiReferencesChange` with it appended; staging an already-present `{wikiId,path}` no-ops and toasts; staging past `MAX_WIKI_REFERENCES_PER_MESSAGE` toasts and doesn't call `onWikiReferencesChange`; staging a 3rd item when 2 wiki references + 2 attachments already fill the shared cap of 4 also toasts and blocks, even though 2 is under the wiki-only sub-limit; `stageFiles` computes `remainingSlots` against `attachments.length + wikiReferences.length`, not `attachments.length` alone; chip remove (×) calls `onWikiReferencesChange` with it filtered out.
- **Unit**: `wiki-update-message.test.tsx` — `Add to Message` calls `onStageWikiReference` with the card's own `{wikiId, path, title}`; renders the "Added" disabled state when `isStaged` is true; button absent when `message.path` is undefined (same guard as `Open`).
- **Orchestration**: `thread-message.test.tsx` — `wiki_update` case receives `onStageWikiReference`/`stagedWikiReferenceKeys` and computes `isStaged` correctly from the key set.
- **Orchestration**: one per route/stream-handler (`chat.route.test.ts` or its `stream-handler.test.ts` equivalent, plus the workspace-chat and wiki-ingestion counterparts) — `wikiReferences.length > 2` rejects with 400; `attachmentIds.length + wikiReferences.length > 4` rejects with 400 even when each individually is within its own sub-limit (e.g. 3 attachments + 2 wiki references); a valid combination reaches `recordUserMessage` and `configurable.wikiReferences` unresolved (spy, not re-testing resolution logic already covered above).
- No eval scenario — resolution is deterministic (file read + string formatting), not LLM-facing judgment; the only LLM-facing behavior (whether the model actually uses the citation to call `wiki_update_page`) is an existing capability `wiki_update_page`'s own tool-call evals already cover, not something this feature changes.
