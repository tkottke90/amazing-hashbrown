# Workspace Chat Tab — Design

**Date:** 2026-08-26
**Status:** Draft
**Related:** [Issue #75](https://github.com/tkottke90/amazing-hashbrown/issues/75)

---

## Goal

Give each workspace its own persistent, workspace-scoped chat conversation — visible in the workspace's Chat tab, oriented to that workspace's goal/location/wiki, and kept from growing unbounded via periodic LLM summarization — so users can ask questions, review agent reasoning, and issue follow-ups without re-establishing context on every message the way the global chat requires today.

---

## Problem

The Chat tab in `ui/src/pages/workspaces/[id].tsx` is a placeholder stub (`<div>Chat tab coming soon.</div>`). Nothing links a workspace to a conversation thread: `threads` has no `workspace_id`/equivalent, and `ThreadType` is a closed `'chat' | 'wiki'` union. The global chat's `use-thread.ts` hook is a module-level singleton keyed by a single `localStorage`-persisted `activeThreadId` — it cannot host a second, independent conversation running concurrently with the global `/chat` page. No agent code path threads workspace context (goal, location, bound wiki) into a chat session, and no code enforces the "project workspaces may only write to their own wiki" rule described in the issue — `wikiId` is accepted as an arbitrary string on every wiki-write tool call today, regardless of caller. Finally, nothing in the codebase summarizes a long conversation to bound its size; the closest precedent, `generateTitleHandler`, produces a 6-word title, not a context-preserving summary.

---

## Non-goals

- **Per-workspace override of the summarization threshold.** The threshold is a single global config value (`env.chat.workspaceSummary.messageThreshold`), matching how the existing, analogous `conversationSearch.threshold` works today. A per-workspace override is a plausible follow-up but needs new settings-storage infrastructure this codebase doesn't have yet.
- **Wiki-write restriction for non-project workspaces.** Only workspaces with a `projects` row are hard-restricted to their configured `wiki_id`. Plain workspaces' chat agent can write to any registered wiki domain, unchanged from today's global-chat behavior.
- **Evaling wiki orientation itself.** Whether the agent uses its bound wiki domain when asked to search/write is already covered generically by `suites/wiki-navigation.yaml` and `suites/wiki-search.yaml`. Wiring `wiki_id` into the workspace-chat system prompt is an integration concern, verified by handler tests, not a new eval.
- **Real-time queue-status delivery beyond this chat session.** The `queue_status` SSE event is scoped to the workspace-chat stream connection; it does not add a general-purpose queue-status push mechanism for other parts of the UI.

---

## Design

### Data model

New migration, version **23** (next free slot — thread-store claims 1-16, workspace-store claims 18-22; see the shared counter comment in both files):

```sql
ALTER TABLE workspaces ADD COLUMN thread_id TEXT REFERENCES threads(id);
ALTER TABLE workspaces ADD COLUMN summary_path TEXT;
ALTER TABLE workspaces ADD COLUMN last_summarized_message_id TEXT;
```

- **`thread_id`** — the workspace's one chat thread, source of truth for the 1:1 relationship. Set as soon as the Chat tab generates a UUID client-side (via a `PATCH` to the workspace), before any message is sent — mirroring how the global chat already holds a client-generated thread id in `localStorage` before the thread row exists. If a workspace already has `thread_id` set, the tab never generates a new one; it always appends to the existing thread.
- **`last_summarized_message_id`** — the summary cursor. Messages with `seq` greater than this id's `seq` are "since last summary" and visible; everything at/before is hidden from the UI (not deleted from the thread).
- **`summary_path`** — relative path to the latest summary file under `<workspace.location>/.hashbrown/summaries/`, used both for the UI's context-notice link and for injecting summary content into the agent's next-session context.

`threads.type` — the `ThreadType` TypeScript union widens to `'chat' | 'wiki' | 'workspace-chat'`. **No DB migration needed for this**: the `type` column is a plain `TEXT NOT NULL DEFAULT 'chat'` with no `CHECK` constraint (confirmed in `thread-store.ts`'s migration history). The global chat sidebar's `listThreads({type: 'chat'})` call already excludes other types, so `'workspace-chat'` threads are excluded from it for free, the same way `'wiki'` threads already are.

A generated summary is written as a normal `thread_messages` row with a new `kind: 'summary'`, alongside the `.md` file on disk. The DB row lets the next-session context builder find "the latest summary content" without a synchronous filesystem read on the hot path; the file is the durable, human-readable, linkable artifact.

New global config, alongside `contextWindow`/`conversationSearch` in `api/src/config/env.ts`:

```ts
export const WorkspaceSummarySchema = z.object({
  enabled: z.boolean().default(true),
  messageThreshold: z.number().default(40),
});
```

### Backend: streaming, wiki orientation, and enforcement

New `api/src/agents/workspace-chat-stream-handler.ts`, following the existing `wiki-stream-handler.ts` precedent for adding a third SSE chat surface: it exports `streamWorkspaceChatToSse` (+ resume/retry variants) and reuses `writeSseEvent`/`pipeEvents`/`finalizeTurn`/`thread-message-writer.ts` verbatim from `stream-handler.ts`. It differs only in:

- Calling `upsertThreadOnFirstMessage(workspace.threadId, ..., 'workspace-chat')` instead of the `'chat'`/`'wiki'` variants.
- Building a workspace-aware system prompt from the workspace's `name`, `goal`, `location`, `system_prompt` column, and the resolved wiki domain (`registry.load(workspace.wikiId)`, the same resolution `GET /api/v1/wiki/domains` already uses) — so the agent is oriented from the first turn.
- Passing `workspaceId` (and, for project workspaces, the project's `wiki_id`) through the same `context: {...}` bag stream-handler.ts already uses to thread `provider`/`model` into tool calls.
- Applying the same `TaskScheduler.pause()`/`.scheduleResume()` discipline around the turn as global chat (issue #68) — a workspace-chat turn pauses the queue exactly like a global-chat turn does today.

New route: `POST /api/v1/workspaces/:workspaceId/chat/:threadId` (+ `/hitl`, `/retry` mirrors), a thin Express shim like the existing two — resolves the workspace by `:workspaceId`, 404s if `thread_id` doesn't match `:threadId`, and delegates to the handler.

**Wiki-write enforcement:** `wiki-create-page.tool.ts`/`wiki-update-page.tool.ts` read `context.workspaceId` when present. If that workspace has a `projects` row, the tool call's `wikiId` argument is compared against the project's workspace's `wiki_id`; a mismatch returns a tool-error result (the same pattern already used for `unknown_wiki`) instead of performing the write. Global chat and non-project workspace chats pass no such restriction, unchanged from today.

**Queue-pause status bar:** the workspace-chat SSE stream emits a `queue_status` event (`{paused: boolean}`) reflecting `TaskScheduler`'s pause state, delivered over the same connection as the chat stream rather than a separate polling endpoint. The Chat tab renders the status bar from this event.

### Summarization flow

**Trigger:** after each turn finalizes (inside the workspace-chat handler's `finalizeTurn`), count messages since `workspace.last_summarized_message_id` (or all messages, if null). If the count reaches `env.chat.workspaceSummary.messageThreshold`, summarization runs automatically. The "Summarise" button in the Chat tab header calls the same function on demand, skipping the threshold check.

**Generation** — new `api/src/agents/workspace-summarizer.ts`, modeled on `generateTitleHandler`'s transcript-building/truncation pattern but producing a fuller summary (key decisions, open threads, files touched) rather than a 6-word title:

1. Build a transcript of messages since the cursor.
2. Call the model directly (like `generateTitleHandler`, not through the full agent tool-calling harness) for a structured summary.
3. Write the result to `<workspace.location>/.hashbrown/summaries/<ISO-timestamp>.md`.
4. Insert a `kind: 'summary'` message into the thread at the current tail `seq`.
5. Update `workspace.last_summarized_message_id` and `workspace.summary_path` to the new cursor/file.

**During generation:** the workspace-chat SSE stream emits a `summarizing_start` / `summarizing_end` event pair (same transport as `hitl_prompt`, no new plumbing needed); the Chat tab disables its input and shows a "Summarising…" state for that span.

**Read side:** fetching thread messages for the workspace Chat tab filters out anything at or before `last_summarized_message_id`, and the response includes `{summaryPath, summarizedAt}` so the UI can render a context notice ("Summary available — view file") above the visible messages.

**Next agent session:** the system-prompt builder (above) reads `workspace.summary_path` when set, includes that file's contents as the leading context block, then appends messages since `last_summarized_message_id` — a session bootstrapped from a summary plus a recent tail, rather than full history.

### Frontend

**`useThread(threadId)` factory** — refactor `ui/src/hooks/use-thread.ts` from module-level singleton signals into a factory function returning a fresh set of signals (`messages`, `isStreaming`, `activeThreadId`, etc.) per call, memoized per `threadId` so repeated calls with the same id return the same instance rather than resetting state. The global `/chat` page keeps calling it with its `localStorage`-persisted `activeThreadId`; the workspace Chat tab calls it with `workspace.threadId`. All existing streaming/HITL/retry logic is untouched — only the "where does state live" wrapper changes. This also fixes a latent bug: today, nothing else creates a second thread, but once the workspace Chat tab exists, having both the global chat and a workspace chat streaming at once would otherwise corrupt shared singleton state.

**Chat tab component** — new `ui/src/components/workspace-chat-tab.tsx`, composed from existing pieces, following the issue's layout note (`height: 520px; border-radius: 12px`):

- Queue-pause status bar (from the `queue_status` SSE event) at the top, shown only while paused.
- Context notice (from the summarization flow) when a summary exists, above the message list.
- `ChatMessageScrollWrapper` + `ThreadMessageItem` reused verbatim for history rendering.
- `ChatInput` reused verbatim; disabled with a "Summarising…" indicator during summarization. A "Summarise" button lives in the tab header (not inside `ChatInput`), wired to the on-demand summarization call.
- On first mount with no `workspace.threadId`, the tab generates a UUID client-side and immediately `PATCH`es it onto the workspace record, so a page reload before the first message still reuses the same thread id.

**Navigation persistence:** since state lives keyed by `workspace.threadId` rather than tied to tab mount, switching to Tasks/Files and back to Chat re-renders against the same `useThread(workspace.threadId)` instance — no extra persistence work needed beyond what the factory already provides.

---

## Error handling

| Case | Behavior |
| --- | --- |
| Summarization fails (LLM error, file-write failure) | `last_summarized_message_id`/`summary_path` unchanged; `summarizing_end` emitted with an error flag; input re-enabled, no partial cursor advance |
| Wiki write rejected (project workspace, mismatched `wikiId`) | Tool-error result the agent can explain to the user; not a stream failure |
| Workspace has no `wiki_id` configured | Workspace-chat system prompt omits wiki orientation; session proceeds normally |
| Thread fetch for a `workspace.thread_id` set but not yet created (pre-first-message) | Empty history returned, not a 404 — same lazy-creation semantics as global chat today |

---

## Testing

**Backend** (following existing handler/store test conventions):
- Migration v23: columns exist, `thread_id`/`summary_path`/`last_summarized_message_id` all nullable, no data loss on existing rows.
- `workspace-chat-stream-handler.ts`: reuses `stream-handler.ts`'s existing test patterns for the shared pipeline; adds cases for system-prompt construction (workspace fields + wiki domain present) and `context.workspaceId` threading.
- Summarization: threshold-crossing triggers automatic summarization; on-demand button bypasses the threshold; cursor and `summary_path` update atomically with the inserted `kind: 'summary'` message; failure leaves the cursor untouched.
- Wiki-write enforcement: project workspace + mismatched `wikiId` → rejected; project workspace + matching `wikiId` → allowed; non-project workspace → unrestricted, matching current behavior.

**Frontend:**
- `useThread` factory: two instances constructed with different thread ids don't share signal state; the same thread id returns the same instance across calls.
- `workspace-chat-tab.tsx`: hidden-message filtering by cursor; summarizing-disabled input state; context notice renders and links to `summaryPath`.
- Manual/regression check: global `/chat` page and a workspace Chat tab open at once, each streaming, don't cross-contaminate each other's state — this is exactly the bug the `useThread` factory refactor fixes, so it's the regression that matters most here.

---

## Evaluations

Most of this feature is deterministic persistence/routing/enforcement, covered by the unit and integration tests above. Two pieces are genuinely LLM-quality-facing and belong in `suites/*.yaml`, per this repo's existing convention of evaling only model-output quality (see `thread-titles.yaml`'s scope note):

- **New `suites/workspace-summary.yaml`**, modeled on `thread-titles.yaml` (`appliesHarnessSystemPrompt: false`, since the summarizer calls the model directly, not through the full tool-calling agent harness). Scenarios: a summary retains a decision made many turns back; a summary omits resolved/irrelevant chatter; a summary stays within a reasonable length bound; a summary generated from a transcript with file/path mentions retains them (since they're likely relevant to "files touched").
- **New scenarios added to the existing `suites/wiki-write.yaml`**, alongside its current duplicate-page recovery scenarios, covering the "wiki write rejected for the wrong project wiki" path: the agent should explain the restriction clearly to the user rather than retry-looping the same write or claiming success.

No new eval suite for wiki orientation itself — `suites/wiki-navigation.yaml` and `suites/wiki-search.yaml` already cover domain-scoped agent behavior generically; wiring `wiki_id` into the workspace-chat prompt is verified by the handler tests above, not a new eval concept.
