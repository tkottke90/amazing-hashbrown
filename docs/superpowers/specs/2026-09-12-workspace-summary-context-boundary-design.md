# Workspace Summary as a Context Boundary — Design

**Date:** 2026-09-12
**Status:** Approved

---

## 1. Problem & Goal

The workspace-chat "Summarise" button (`workspace-summarizer.ts`, `workspace-chat-tab.tsx`) generates a markdown recap of the conversation and writes it to `.hashbrown/summaries/<timestamp>.md`. Today that's all it does for context management:

- The recap is a side artifact — it is never read back into the agent's context. `buildWorkspaceContextBlock` (`chat-agent.ts`) has no reference to `workspace.summaryPath` at all, despite an existing code comment in `workspace-summarizer.ts` claiming "the system prompt's context block now includes this summary." That comment is stale/incorrect as written today.
- `invalidateWorkspaceChatAgent(workspaceId)` is called after every summarize, but since nothing downstream actually consumes the summary, the cache-bust currently accomplishes nothing.
- The LangGraph checkpointer that holds the actual model-facing conversation state (`getCheckpointer()` in `chat-agent.ts`) has zero awareness that a summarize ever happened. It is a completely separate storage system from the `thread_messages` SQL table the summarizer reads from and the `afterMessageId` cursor that hides old messages in the UI.
- The shared sliding-window trimmer (`createContextWindowMiddleware`) only knows how to cut on Human-message boundaries (`startOn: 'human'`). It has no concept of a summary ever having happened, so a long-running workspace's real per-call context keeps growing exactly as if Summarise were never pressed.

**Goal:** make a workspace's summaries actually do something for context management — surface the latest one (and point at older ones) in the system prompt, and let the shared context-window middleware treat a summary as a preferred place to cut when it has to trim for token budget — without resetting or truncating the checkpointer's underlying conversation history, and without adding anything workspace-specific to that shared middleware (it's also used by Thread chat and Wiki chat, per `chat-agent.ts:370,443,582,646`).

---

## 2. Design

Three additive touch points. Nothing existing is removed, and the checkpointer's raw message history is never deleted or rewritten.

### 2.1 Boundary marker in checkpoint state (`workspace-summarizer.ts`)

After `maybeSummarizeWorkspace` writes the summary file, inserts the `kind: 'summary'` row into `thread_messages`, and patches `workspace.summaryPath` / `lastSummarizedMessageId` (all unchanged), it gains one new step: append a lightweight marker message directly into that thread's LangGraph checkpoint, via the compiled agent's state-update API (`agent.updateState(config, { messages: [...] })` — the standard LangGraph mechanism for injecting a state update outside of a normal `invoke`/`streamEvents` call, as opposed to the raw checkpoint-tuple manipulation `thread-fork.ts` uses for a structurally different problem, replaying an entire ancestor chain under a new thread id).

The marker:

- Is **content-light** — something like `[Workspace summary generated — see system prompt for the latest summary]`, not the summary text itself. The full summary text lives in the system prompt (§2.3); duplicating it into the message list as well would pay the token cost twice and create two sources of truth that can drift.
- Is tagged for identification via `additional_kwargs`, e.g. `{ hashbrown: { kind: 'summary-boundary', summaryPath } }`.
- Is **not** typed as a `SystemMessage`. `beforeModel`'s existing trimmer already sets `includeSystem: true`; today that's a no-op because `state.messages` never actually contains a system message (the system prompt is passed to `createAgent` separately and reaches the model via `request.systemMessage`, never through `state.messages`). Typing our marker as `system` would risk silently invoking whatever "always keep the system message" behavior `includeSystem` implements, turning the intentionally soft boundary preference (§2.2) into a hard floor. The marker is typed as a normal `AIMessage` instead, so it's subject to normal trimming like everything else, and detection is done purely via the `additional_kwargs` tag, not the message type.

This call is wrapped in the same try/catch `maybeSummarizeWorkspace` already uses end-to-end — see §3.

**Implementation note:** the exact state-update call (`agent.updateState(...)` or equivalent) needs to be confirmed against the installed `@langchain/langgraph`/`langchain` versions (`1.4.4`/current) when this is implemented — this design environment had no `node_modules` available to verify the precise method signature against source. The requirement itself is unambiguous (append one message to an existing thread's persisted checkpoint state without running a full agent turn); only the exact call site needs pinning down during implementation, following the existing direct-checkpointer-manipulation precedent in `thread-fork.ts` if the higher-level API turns out not to fit.

### 2.2 Two-stage boundary-aware trim (`chat-agent.ts`)

`createContextWindowMiddleware` gains a shared helper, used by both its `beforeModel` and `wrapModelCall` hooks instead of each calling `trimMessages` directly:

```
function boundaryAwareTrim(
  messages: BaseMessage[],
  maxTokens: number,
  tokenCounter: (msgs: BaseMessage[]) => number,
): Promise<BaseMessage[]> {
  const boundaryIdx = findLastIndex(messages, isSummaryBoundary);

  if (boundaryIdx !== -1) {
    const sinceBoundary = messages.slice(boundaryIdx);
    if (tokenCounter(sinceBoundary) <= maxTokens) {
      return sinceBoundary; // fits untouched — no trim needed
    }
    // Falls through: boundary-forward slice alone still exceeds budget.
  }

  // No boundary, or boundary-forward slice doesn't fit — today's exact
  // behavior, unchanged.
  return trimMessages({
    maxTokens,
    strategy: 'last',
    tokenCounter,
    includeSystem: true, // unchanged from today
    allowPartial: false,
    startOn: 'human',
  }).invoke(messages);
}
```

(`isSummaryBoundary` checks the `additional_kwargs` tag from §2.1; `findLastIndex` finds the most recent one, in case a workspace has summarized more than once.)

This is deliberately a **soft** preference, not a hard floor: if `[boundary, ...everything since]` already exceeds the token ceiling on its own (a very active workspace since the last summarize), stage two takes over and can cut into those messages or drop the boundary entirely, exactly like it would cut into any other span today. The ceiling is never violated to protect a boundary.

Threads with no boundary message — Thread chat, Wiki chat, or a workspace that has never summarized — never hit the `boundaryIdx !== -1` branch at all, so behavior is byte-for-byte identical to today. This is what makes the change safe to land in a middleware shared across all three chat surfaces without any workspace-specific branching in the shared code, and without Thread/Wiki chat needing to change anything to stay correct.

`wrapModelCall`'s existing tool-schema-aware budget calculation is unchanged — only the final `trimMessages(...).invoke(...)` call inside it is replaced with `boundaryAwareTrim(...)`, called with the same computed `budget`.

### 2.3 System prompt awareness of all summaries (`buildWorkspaceContext`, `buildWorkspaceContextBlock`)

`buildWorkspaceContext` (`workspace-chat-stream-handler.ts`) additionally lists `.hashbrown/summaries/` in the workspace directory, sorted by filename (the existing naming scheme is an ISO-derived timestamp, so lexical sort is chronological):

- The **most recent** file's full content is read and passed through.
- **Older** files are reduced to a manifest: filename + timestamp (parsed from the filename) for each.

`WorkspaceChatContext` gains two optional fields (`latestSummary: string | null`, `olderSummaries: { path: string; timestamp: string }[]`). `buildWorkspaceContextBlock` renders them into the system prompt roughly as:

```
## Prior work summary
<latest summary's full markdown content>

## Earlier summaries (read via shell if needed)
- .hashbrown/summaries/2026-09-01T12-00-00-000Z.md
- .hashbrown/summaries/2026-08-20T09-30-00-000Z.md
```

No new tool is introduced for reading older summaries — workspace chat already binds `makeShellExecTool(workspaceContext.location)`, so the agent can `cat` any listed path itself if it decides the older context is relevant. This keeps steady-state system-prompt token cost flat regardless of how many summaries a long-running workspace accumulates: cost only grows with the manifest (one line per summary), not with content.

This is scoped to workspace chat only — Thread chat and Wiki chat have no `.hashbrown/summaries/` directory or `summaryPath` concept and are untouched.

### 2.4 Explicitly out of scope

- **The chat UI's display behavior.** The `afterMessageId` cursor that hides messages at/before the last summary from the chat transcript (`workspace-chat.route.ts`'s `GET /:threadId`, `workspace-chat-tab.tsx`'s "Earlier messages were summarised" banner) is unchanged. This design is about what the *model* sees, not what the *user* sees in the transcript.
- **Resetting or compacting the checkpointer.** The checkpointer keeps 100% of raw history forever, exactly as today. The boundary marker is additive metadata for the trimmer, not a replacement for anything.
- **Adding Summarise to Thread or Wiki chat.** Only the shared middleware and message-tagging convention are made summary-aware; nothing here adds a Summarise button anywhere but workspace chat.

---

## 3. Error handling

- **Boundary-marker insertion fails** (state-update call throws, checkpoint doesn't exist yet, etc.) — caught inside `maybeSummarizeWorkspace`'s existing try/catch, which already guarantees the function never throws (its callers run it after `finalizeTurn` has already completed the turn). The summary file and `thread_messages` row are written before this step, so the user-visible summarize action still succeeds; only the trim-boundary optimization is lost for that one summary. Logged at `warn`. `summarizing_end` still fires as a success, not an error — from the user's perspective, summarizing worked.
- **`.hashbrown/summaries/` unreadable or missing, or a dangling `summaryPath`** (file deleted externally) — caught in `buildWorkspaceContext`; falls back to omitting the latest-summary block and/or the manifest for that turn rather than failing agent construction. Logged at `warn`.
- **No boundary marker present anywhere in history** — `boundaryAwareTrim`'s first branch simply isn't taken (`boundaryIdx === -1`); falls straight through to today's unchanged `trimMessages` call. This is the default and only path for Thread chat and Wiki chat.

---

## 4. Testing

- **`chat-agent.test.ts`** — new unit tests for `boundaryAwareTrim` directly: a message list with a tagged boundary that fits under budget (boundary-forward slice returned untouched); one where the boundary-forward slice alone exceeds budget (falls back to full-history trim, may cut past the boundary); a list with no boundary tag at all (byte-for-byte matches today's `trimMessages` output). One test confirming `wrapModelCall`'s tool-aware budget still routes through the same helper.
- **`workspace-summarizer.test.ts`** — assert the boundary message is appended to checkpoint state after a successful summarize, tagged correctly and typed as `AIMessage`; assert a forced insertion failure still leaves the summary file and `thread_messages` row intact and does not propagate an error out of `maybeSummarizeWorkspace`.
- **`chat-agent.test.ts` (or a new `workspace-chat-stream-handler.test.ts` case)** — `buildWorkspaceContext` happy path (latest inlined, older manifested); missing `.hashbrown/summaries/` directory; dangling `summaryPath` reference.
- One end-to-end-style test: summarize → next turn's system prompt contains the latest summary content and the older-summaries manifest → a follow-up turn constructed with a small token budget demonstrates the boundary-preferred slice surviving intact while earlier, pre-boundary messages are the ones trimmed.
