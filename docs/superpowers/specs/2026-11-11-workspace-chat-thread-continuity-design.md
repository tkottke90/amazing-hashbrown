# Workspace Chat thread continuity: summary frontmatter, `search_threads`, and Replace Thread

## Problem

Workspace Chat is bound to exactly one thread per workspace. The existing
summarization mechanism (`maybeSummarizeWorkspace`) keeps that one thread's
context window bounded, but gives no way to leave it: a long thread can
accumulate enough stale context that the agent insists something can't
change even after the user has already corrected it, and there is no
way to start over without losing access to everything that thread knew.

This spec covers three changes that together let a workspace's chat escape
a stuck thread without losing the ability to look back:

1. **Workspace Chat Summary** frontmatter, so a summary is self-describing
   about what it covers.
2. A `search_threads` tool, so an agent that already knows a threadId can
   read into it.
3. **Replace Thread**, a UI action that retires the current thread in
   favor of a fresh one, using (1) and (2) as the glue.

See `GLOSSARY.md` ("Workspace Chat Continuity Across Threads") for the
canonical terms used below (**Workspace Chat Summary**, **Supersession
Reference**, **Replace Thread**), and ADR-0063/0064/0065 for the three
decisions that would otherwise be surprising to a future reader. This spec
doesn't restate either — it covers the concrete implementation.

## Non-goals

- **Searching for a conversation by content when the threadId isn't
  already known.** `search_threads` takes a required `threadId`; there is
  no discovery/search-across-threads mode. If the agent doesn't have an id,
  it doesn't use the tool.
- **An agent-invocable "start fresh" tool.** Replace Thread is a UI action
  only (a button next to the existing "Summarise" button). The model never
  decides on its own to abandon a thread.
- **Backfilling frontmatter onto summaries written before this change.**
  They simply have none; readers treat absence as "unknown."
- **A database-level authorization boundary on `search_threads`.** See
  ADR-0063.

## 1. Workspace Chat Summary frontmatter

`maybeSummarizeWorkspace` (`api/src/agents/workspace-summarizer.ts`) writes
the file at `summaryRelPath` as plain LLM output today. It gains a YAML
frontmatter block (via `gray-matter`, the same library already used for
Task Files, wiki pages, and skill artifacts) ahead of that body:

```yaml
---
threadId: <workspace.threadId>
covers_from_seq: <seq of the first row in `conversational`>
covers_to_seq: <seq of the last row in `conversational`>
supersededBy: <newThreadId>   # only present when this is a Replace Thread's final summary
---
```

- `covers_from_seq`/`covers_to_seq` are `thread_messages.seq` values (raw,
  monotonic, per-thread — not a Turn count), read directly off the
  `conversational` array the function already builds (the `kind:'user'|
  'assistant'` rows filtered from `sinceLast`). No new query is needed —
  `conversational[0].seq` and `conversational[conversational.length -
  1].seq`.
- `threadId` is `workspace.threadId` at the moment of the call.
- `supersededBy` is new: `maybeSummarizeWorkspace` gains an optional
  parameter, `{ force, supersededBy }: { force?: boolean; supersededBy?:
  string }`, written into frontmatter only when present. No other behavior
  changes based on it.
- No database schema changes. All four fields live only in the markdown
  file's frontmatter — `workspaces`/`threads` gain no new columns for this
  part.
- `loadWorkspaceSummaries` (`workspace-chat-stream-handler.ts`) keeps
  returning raw file content for `latestSummary` — parsing the frontmatter
  out for display, vs. leaving it inline for the model to read as part of
  the summary text, is an implementation choice left to whoever builds
  this; either is fine since the system prompt already treats the summary
  as opaque markdown.

## 2. `search_threads` tool

New file: `api/src/agents/tools/search-threads.tool.ts`, modeled on
`search-conversation.tool.ts` (ranking machinery) and
`read-workspace-task-run.tool.ts` (range/paging shape).

```ts
const SearchThreadsSchema = z.object({
  threadId: z.string().describe(
    'The id of a thread you already know about — e.g. from a Workspace Chat Summary\'s ' +
    'frontmatter, or from a sub-agent completion notification. Never guess or search for an id.'
  ),
  lookup: z.string().optional().describe(
    'Free-text query to rank matches within the target thread (and within start/end if given). ' +
    'Omit to get a plain range instead of a ranked search.'
  ),
  start: z.number().int().optional().describe('First seq (inclusive) to include, e.g. from covers_from_seq.'),
  end: z.number().int().optional().describe('Last seq (inclusive) to include, e.g. from covers_to_seq.'),
});
```

Behavior:

- Resolve the caller's own thread id from `config.configurable.thread_id`.
  If `threadId === ` that value, return a short refusal: use
  `search_conversation` for your own thread instead. (ADR-0063 covers why
  this is the only guard — there is no ownership check beyond it.)
- Load `threadId`'s messages via `getThreadStore().getThreadMessages
  (threadId)` — no restriction on `ThreadType` or `archivedAt`; any
  existing thread (chat, workspace-chat, wiki, task; active or archived)
  is readable this way, consistent with how an Archived Thread already
  stays readable everywhere except its write-ish routes (GLOSSARY's
  **Archived Thread**).
- If `threadId` doesn't resolve to any thread, say so plainly.
- Filter to `[start, end]` by `seq` when either is given (open-ended on
  whichever side is omitted).
- If `lookup` is given: rank within that filtered set using the same
  embedding/keyword fallback `search_conversation` already implements —
  factor that ranking logic out into a shared helper both tools call,
  rather than duplicating it. Cap results at 20, same as
  `search_conversation`.
- If `lookup` is omitted and both `start`/`end` are omitted: return the
  most recent N messages (a tail), same default-window idea as
  `read_workspace_task_run`'s `offset`/`limit`, capped at 40.
- If `lookup` is omitted but `start`/`end` are given: return the raw
  messages in that range, capped at 100 (matching
  `read_workspace_task_run`'s own cap).
- Output shape mirrors `search_conversation`'s (`seq`, `kind`, excerpt,
  plus `score` only when `lookup` was used).

Binding: add to `STATIC_CHAT_TOOLS` in `chat-agent.ts`, alongside
`spawn_sub_agent`/`search_conversation` — so it's available in plain chat,
workspace chat, and task agents, and reachable by a sub-agent run through
the existing config-driven candidate pool (`getSubAgentToolIds()`) with no
further change needed there. It is **not** a replacement for
`read_workspace_task_run`, which stays as-is for its narrower
taskId/runId-addressed case; the two simply overlap for a `'task'`-type
thread.

### Companion fixes these benefits actually depend on

Nothing today exposes a sub-agent task run's raw `threadId` to the calling
model. Two fixes, both small:

- **`get_task_outcome.tool.ts`**: `describeRun()` currently prints
  `#{runNumber} {run.id} ({status}, via {triggerSource})` — add the run's
  `threadId` (already on `TaskRun`) to that line.
- **`sub-agent-notification.ts`**: `buildNotificationMessage()` builds the
  plain text actually fed into the parent thread's next turn as
  `{role:'human', content: message}` — the structured `sub_agent_marker`
  row already threaded through `runThreadId` is bookkeeping for the UI,
  not something replayed into the model's context. Add a line when
  `runThreadId` is present, e.g. `` Thread: `{runThreadId}` (use
  search_threads to look into it) ``.
- `spawn_sub_agent`'s own dispatch return payload is **not** changed — at
  dispatch time no run/thread exists yet (`task_queue.thread_id` is minted
  on the run's first start, per `api/AGENTS.md`), so there is nothing to
  report there.

## 3. Replace Thread

New endpoint, e.g. `POST /api/v1/workspaces/:id/chat/replace-thread`
(`workspace-chat.route.ts`), triggered only from a new UI button placed
next to the existing on-demand "Summarise" button. Not an agent tool.

Server-side sequence, as one handler:

1. `newThreadId = randomUUID()`. No thread row needs to be pre-created —
   `upsertThreadOnFirstMessage()` already lazily creates a thread's row on
   its first real message, same as any ordinary new workspace-chat
   thread, so the successor thread materializes normally once the user
   sends into it.
2. Call `maybeSummarizeWorkspace(..., { force: true, supersededBy:
   newThreadId })` against the *current* `workspace.threadId`. This is the
   one and only write of the final summary — no follow-up edit of the
   markdown file to inject `supersededBy` after the fact.
3. Archive the old thread (`store.archiveThread(oldThreadId)`), and rename
   its title to `` `${title} (replaced)` ``, matching the existing
   convention where a Fork's title becomes `${source.title} (fork)`.
4. Cancel any pending wake-up on the old thread (`WakeupRegistry`/
   `WakeupStore` — `archiveThreadHandler` does not do this today for
   Archiving in general; Replace Thread does it explicitly as part of its
   own atomic step, since an Archived Thread can never run the turn a
   wake-up would resume).
5. `store.patchWorkspace(workspace.id, { threadId: newThreadId,
   lastSummarizedMessageId: null })`. `summaryPath` is **not** touched —
   it keeps pointing at the just-written final summary, which is exactly
   what the new thread's `buildWorkspaceContext` picks up as its "latest
   summary" on its very first turn (summaries already live per-workspace
   on disk, not per-thread, so no new plumbing is needed for the new
   thread to see it).
6. The new thread gets no `forked_from_thread_id`/`forked_from_seq` (see
   ADR-0065) and no checkpoint copied (see ADR-0064) — it is a plain blank
   thread.
7. Return the new thread id so the UI can navigate to it.

If step 2, 3, or 5 fails partway, the handler should not leave the
workspace half-migrated — wrap the DB writes (archive + patchWorkspace) in
one transaction; a failure in the force-summarize step (network/model
error) should abort before any of them run.

## Testing

Per the root `AGENTS.md`, every piece here ships with tests in the same
PR, following the existing adjacent-file convention:

- `workspace-summarizer.test.ts`: extend for frontmatter fields and the
  new `supersededBy` parameter.
- `search-threads.tool.test.ts` (new): unit tests for the self-thread
  refusal, range filtering, tail default, and ranked-lookup path (stub the
  ranking helper rather than re-testing `search_conversation`'s own
  embedding logic).
- `get-task-outcome.tool.test.ts`: extend to assert `threadId` appears in
  `describeRun()`'s output.
- `sub-agent-notification.test.ts`: extend to assert the `Thread:` line
  appears in the delivered message when `runThreadId` is present.
- New handler test for the Replace Thread endpoint, following the
  `*.handlers.ts` pattern (plain handler function, no supertest/live
  server) — cover the full sequence (summary written with `supersededBy`,
  old thread archived and retitled, wake-up cancelled, workspace patched)
  and the partial-failure/rollback case.
- Per `AGENTS.md`'s Evaluation-Driven Development rules: `search_threads`
  is LLM-facing tool-call behavior, so a `tool-call`-type eval scenario
  (confirming the model calls it with a known threadId, and does *not*
  call it on its own thread) belongs in `suites/` before this ships,
  written first per rule 1.
