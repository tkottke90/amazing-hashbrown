# `get_tool_key` — Read-Side KV Exchange Tool — Design

**Date:** 2026-09-08
**Status:** Draft
**Related:** None (originated from a chat question about KV exchange, not a filed issue)

---

## Goal

Give the model a general-purpose way to read back content it previously offloaded to the KV store — the same store `web_fetch` already writes to when a result is too large to return inline — for any purpose other than wiki ingestion, which already has its own direct path.

---

## Problem

`api/src/services/tool-content-store.ts` is a tiny in-memory `Map<string, string>` keyed by `${threadId}:${toolKey}`, written by `web_fetch` (`api/src/agents/tools/web-fetch.tool.ts`) whenever its result exceeds `STUB_THRESHOLD_CHARS` (10,000 chars). The model gets back a compact stub instead of the full text, with a `{ threadId, toolKey }` pair it can use later.

Today there is exactly one reader: `wiki_create_page`'s `corpus` schema accepts a `{ threadId, toolKey }` union member and calls `getToolContent()` internally (`api/src/agents/tools/wiki-create-page.tool.ts:83`). That's a narrow, wiki-specific consumer baked into one tool's implementation — there is no way for the model to resolve a stub's reference back to the full text for anything else (answering a detailed question, quoting a passage, summarizing beyond what the stub's own summary already covers). If the model needs the real content for one of those cases today, its only options are to answer from the stub's truncated summary or fabricate.

---

## Scope

**In scope:**

- A new standalone tool, `get_tool_key`, wrapping `getToolContent()` as the generic read side of the KV store.
- Registration everywhere `web_fetch` is bound (`STATIC_CHAT_TOOLS` in `chat-agent.ts`, and the wiki-ingestion agent's tool list).
- A new system-prompt paragraph in `WEB_FETCH_SECTION` explaining when to use it, when not to (wiki ingestion), and that it requires a real key.
- Unit tests for the tool.
- A new eval suite, `suites/get-tool-key.yaml`, covering both the tool in isolation and its coordination with `web_fetch`/`wiki_create_page`.

**Out of scope:**

- Any change to `tool-content-store.ts` itself (no TTL/eviction, no consume-on-read) — reads stay non-destructive, matching current behavior.
- Any change to `wiki_create_page`'s existing internal KV resolution — it keeps resolving `corpus:{threadId,toolKey}` itself; `get_tool_key` is an addition, not a replacement.
- Producers other than `web_fetch` — nothing else writes to the KV store today, so there's nothing else for `get_tool_key` to read.

---

## Design

### 1. New tool file `api/src/agents/tools/get-tool-key.tool.ts`

A plain `tool()` export (no factory/closure — unlike `wiki_create_page`, there's no per-wiki scoping to bind), mirroring `webFetchTool`'s shape:

```ts
const GetToolKeySchema = z.object({
  threadId: z
    .string()
    .describe('threadId from an actual compact stub already in this conversation, copied verbatim. Do not invent one.'),
  toolKey: z
    .string()
    .describe('toolKey from that same stub, copied verbatim. Do not invent one.'),
});

export const getToolKeyTool = tool(
  async ({ threadId, toolKey }) => {
    const stored = getToolContent(threadId, toolKey);
    if (!stored) {
      return (
        `[KV content not found — threadId: ${threadId}, toolKey: ${toolKey}. ` +
        `The content may have expired or belong to a different process.]`
      );
    }
    return stored;
  },
  {
    name: 'get_tool_key',
    description:
      'Read back content that was offloaded to the KV store by an earlier tool call (currently only ' +
      'web_fetch, when its result was too large to return inline) because you need the actual text for ' +
      "something other than saving it to the wiki — answering a question in detail, quoting, or " +
      "summarizing beyond the stub's own summary. Requires a real threadId and toolKey copied verbatim " +
      "from that stub's frontmatter (the block starting '── CONTENT OFFLOADED ──'). Do not fabricate " +
      'these values — if there is no stub with a real toolKey in this conversation, there is nothing to ' +
      'exchange; the content already in front of you is everything there is. For wiki ingestion, do not ' +
      'call this first — pass corpus:{threadId, toolKey} directly to wiki_create_page, which resolves the ' +
      'reference itself.',
    schema: GetToolKeySchema,
  },
);
```

The not-found message reuses the exact phrasing already established in `wiki-create-page.tool.ts` for the same failure case, minus the wiki-specific "re-fetch with web_fetch" suggestion (not applicable to a generic caller).

### 2. Registration

Added everywhere `web_fetch` is bound today — same reach as the producer:

- `chat-agent.ts`: new entry in `STATIC_CHAT_TOOLS` (covers `buildChatAgent` and `buildWorkspaceChatAgent`).
- `wiki-ingestion-agent.ts`: new entry in `buildWikiIngestionAgent`'s `tools` array.

### 3. System-prompt addition

`HARNESS_SECTIONS` always renders every section regardless of which tools are actually bound to the current agent (that's precisely what the existing E-12/E-14 `instruction-sensitivity.yaml` scenarios exercise — instruction text present, tool absent, model must not act on it anyway). Since `get_tool_key` is always co-bound with `web_fetch`, its guidance belongs inside the existing `WEB_FETCH_SECTION` in `api/src/agents/system-prompt.ts`, right after the current "to ingest into wiki" paragraph and before the "This only applies when wiki_create_page is actually available" gate paragraph:

> That reference is for the wiki path specifically — do not resolve it yourself first with get_tool_key just to hand the text to wiki_create_page as corpus.raw; pass the corpus:{threadId, toolKey} reference straight through instead. Reach for get_tool_key when you need the offloaded text for anything else — answering a question in more detail than the stub's summary gives you, quoting a passage, or working with the full document yourself. Call it with the same threadId and toolKey shown in the stub, copied verbatim. get_tool_key only works with a real key from an actual stub already in this conversation — never invent a threadId or toolKey to try it speculatively; if there's no stub, the content you have is already everything there is.

This is a wording draft, not final copy — per this codebase's established practice (see the numbered auto-eval history already embedded above `WEB_FETCH_SECTION`), it should be tuned against real local-model runs via the `auto-eval-loop` skill once `suites/get-tool-key.yaml` exists, the same way every other section in this file was iterated.

### 4. Eval suite `suites/get-tool-key.yaml`

New, dedicated suite — same precedent as `instruction-sensitivity.yaml` being its own file for stub/corpus-reference dynamics, rather than folding into `web-fetch.yaml`. Modeled on that suite's `priorTurns` stub-seeding pattern and the `tool-sequence` executor (which scores only the model's next single response against seeded history — see `lib/evaluations/src/executors/tool-sequence.ts`).

| id | type | Seeds | Input | Assertion | Purpose |
| --- | --- | --- | --- | --- | --- |
| **GTK-001-basic-read** | tool-call | A plain research stub (no "to ingest into wiki" block) | A question needing the full text, not just the stub's summary | `get_tool_key` called with `threadId`/`toolKey` matching the seeded stub | Confirms the tool is reachable and the model copies the key correctly |
| **GTK-002-coordination-answer** | llm-judge | The stub, plus a seeded `get_tool_key` result carrying the full article text | A question only answerable from detail not present in the stub's summary | Judge scores the answer for reflecting the full text | Confirms the fetch → stub → resolve → answer chain actually composes |
| **GTK-003-no-fabricated-key** | tool-sequence (negated) | A plain, **non-offloaded** `web_fetch` result (content returned inline, no stub, no key ever issued) | A request phrased to invite fabricating a key (e.g. "get me the full raw text via the tool key") | `!get_tool_key` | Guards against inventing a threadId/toolKey when none was ever issued — mirrors the exact fabrication failure mode already documented in this file's `wfetch-003` auto-eval history for `corpus` |
| **GTK-004-prefers-direct-corpus** | tool-sequence (paired) | A stub with a "to ingest into wiki" block | "Save that to the wiki" | One scenario asserts `wiki_create_page` is called (like `instruction-sensitivity.yaml`'s E-11); a paired scenario on the same seeded turn asserts `!get_tool_key` | Proves the anti-pattern guidance holds — no wasted round-trip through `get_tool_key` before handing the reference to `wiki_create_page` |

`passingThreshold`: 0.8, consistent with the mid-range already used across `web-fetch.yaml` (0.85) and `instruction-sensitivity.yaml` (0.75).

Exact scenario YAML (input phrasing, seeded stub text, argChecks) gets finalized during implementation — the table above fixes the intent and assertions each scenario must make.

---

## Testing

- **New `get-tool-key.tool.test.ts`** (mocha/chai, mirroring sibling tool tests like `wiki-create-page.tool.test.ts`): seed the store via `storeToolContent` directly, assert a hit returns the exact stored string, assert a miss (wrong key or wrong thread) returns the not-found message, assert two reads of the same key both succeed (non-destructive).
- **`suites/get-tool-key.yaml`**: run via `auto-eval-loop` against configured local providers until scenarios pass or a real model-capability ceiling is hit, per this repo's established process. Also re-run `suites/web-fetch.yaml` and `suites/instruction-sensitivity.yaml` once the system-prompt paragraph is added, to confirm no regression in the existing wiki-ingestion routing behavior those suites already lock in.

## Evaluations

Covered by `suites/get-tool-key.yaml` above — this is new model-facing tool-choice behavior, so (unlike purely-wiring changes) an eval suite is required, not optional.
