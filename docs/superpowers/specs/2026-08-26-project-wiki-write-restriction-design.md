# Project Wiki Write Restriction — Scoped Write Tool Guardrail — Design

**Date:** 2026-08-26
**Status:** Draft
**Related:** [Issue #79](https://github.com/tkottke90/amazing-hashbrown/issues/79) (depends on [#77](https://github.com/tkottke90/amazing-hashbrown/issues/77), closed)

---

## Goal

Guarantee — as a hard mechanical check, not a prompt instruction — that an agent running inside a project's workspace context can never mutate a wiki domain other than that project's own, across every wiki tool capable of mutating content, while leaving non-project sessions (global chat, plain workspaces) unrestricted exactly as they are today.

---

## Problem

PR #97 (issue #75, "Workspace Chat Tab") already shipped most of this mechanism as a side effect: `wiki-write.ts` has an `allowedWikiId` parameter and a `wiki_forbidden` result status, and `wiki_create_page`/`wiki_update_page` already reject a mismatched `wikiId` before writing. But two things are incomplete relative to issue #79:

1. **Pattern mismatch.** The restriction is threaded per-turn through `config.configurable.allowedWikiId`, read inside the tool's execute function. Issue #79's AC calls for a construction-time factory (`allowedWikiId` captured in a closure when the tool is built), so the restriction is fixed at agent-construction time rather than re-derived from caller-supplied config on every call.
2. **Coverage gap.** `wiki_add_cross_link` and `wiki_rebaseline_source` also mutate wiki content (adding a link under "Related Pages"; rewriting a raw-source sha256 baseline) but call `WikiRegistry`/`wiki.*` methods directly, bypassing `wiki-write.ts` entirely — so a project-scoped agent can currently use either tool to touch a wiki outside its project, defeating the guarantee the other two tools already enforce.

---

## Non-goals

- **`wiki_register_domain` / `wiki_create_domain`.** These operate at the domain-lifecycle level (registering an existing on-disk directory into the registry; scaffolding a brand-new domain from scratch) rather than writing page content into an existing domain that might belong to someone else. There's no "wrong existing `wikiId`" for them to guard against the same way `wikiId`-scoped page writes do, and the issue's AC only names page-content writes.
- **`wiki_lint`.** Read-only; produces a report, writes nothing.
- **Re-deriving the restriction per-turn.** The factory pattern fixes `allowedWikiId` at agent-construction time. A workspace's `wiki_id` only changes via an explicit patch, which already calls `invalidateWorkspaceChatAgent(workspaceId)` — no new invalidation path is needed.
- **Read tools.** Unaffected by this change; read scope remains broad in every context, per the issue's explicit acceptance criterion.

---

## Design

### 1. Shared rejection-message helper

New `api/src/agents/tools/wiki-write-guard.ts`:

```ts
export function wikiWriteForbiddenMessage(wikiId: string, allowedWikiId: string): string {
  return (
    `This workspace is restricted to writing wiki "${allowedWikiId}" — ` +
    `"${wikiId}" is not allowed here — use wiki "${allowedWikiId}" instead.`
  );
}
```

This is the exact message `wiki_create_page`/`wiki_update_page` already produce for their `wiki_forbidden` status today; extracting it avoids the string being duplicated across four tool files once `wiki_add_cross_link`/`wiki_rebaseline_source` need to produce the same message.

### 2. `wiki_create_page` / `wiki_update_page` become construction-time factories

Both tools currently read `config?.configurable?.allowedWikiId` inside their execute function and pass it to `createWikiPage`/`updateWikiPage`. They change to:

```ts
export function makeWikiCreatePageTool(allowedWikiId?: string) {
  return tool(
    async ({ wikiId, title, corpus, section, ... }, config) => {
      // unchanged body, except:
      const result = await createWikiPage({ wikiId, title, ... }, undefined, allowedWikiId);
      // unchanged switch/status handling — the `wiki_forbidden` branch now
      // calls wikiWriteForbiddenMessage(result.wikiId, result.allowedWikiId)
    },
    { name: 'wiki_create_page', description: ..., schema: WikiCreatePageSchema },
  );
}
```

`config` is still accepted and still used to read `thread_id` for the SSE writer — only the `allowedWikiId` read is removed from it, since the value now comes from the enclosing closure. `wiki-write.ts` itself (the `allowedWikiId` parameter, the `wiki_forbidden` status, the pre-write check) needs no changes — only where the value the tool passes to it comes from.

Same treatment for `makeWikiUpdatePageTool(allowedWikiId?)`.

### 3. `wiki_add_cross_link` / `wiki_rebaseline_source` gain the same restriction

Both convert to the same `make...Tool(allowedWikiId?)` factory shape. Each gets one check inserted immediately after `wiki = await registry.load(wikiId)` (i.e. after confirming the domain exists, so an unknown-domain error still takes precedence over a forbidden-domain one, matching `wiki-write.ts`'s existing precedence):

```ts
if (allowedWikiId !== undefined && wikiId !== allowedWikiId) {
  return wikiWriteForbiddenMessage(wikiId, allowedWikiId);
}
```

Neither tool goes through `wiki-write.ts`, so this check lives directly in the tool file rather than in a shared service — there's no existing service layer for them to share, and adding one purely to host a two-line check would be more machinery than the problem needs.

### 4. Wiring: `chat-agent.ts`

`STATIC_CHAT_TOOLS` currently holds every tool, including the singleton `wikiCreatePageTool`/`wikiUpdatePageTool`/`wikiAddCrossLinkTool`/`wikiRebaselineSourceTool` instances, shared unmodified between the global agent and every workspace agent. It splits into:

- The tools that never vary (everything except the four above) — stays a flat array, unchanged.
- A new `buildWikiWriteTools(allowedWikiId?: string)` helper, called once per agent build, returning the four factory-built tool instances for that `allowedWikiId`.

`buildChatAgent()` (global, unrestricted) calls `buildWikiWriteTools()` with no argument. `buildWorkspaceChatAgent()` gains an `allowedWikiId` parameter and calls `buildWikiWriteTools(allowedWikiId)`; `getWorkspaceChatAgent()` gains the same parameter, passed through to `buildWorkspaceChatAgent` when a cache miss triggers a fresh build.

The existing `_workspaceAgents` cache (keyed `workspaceId:provider:model`) needs no structural change: `allowedWikiId` is a deterministic function of `workspaceId` at the moment of construction, and `invalidateWorkspaceChatAgent(workspaceId)` already fires on a `wiki_id` change (per its existing comment), so a stale-restriction agent is never served from cache after a patch.

### 5. Wiring: `workspace-chat-stream-handler.ts`

The 3 call sites (initial turn, HITL resume, retry) currently do:

```ts
const allowedWikiId = resolveAllowedWikiId(workspaceStore, workspace.id);
...
const config = {
  configurable: {
    thread_id: threadId,
    workspaceId: workspace.id,
    ...(allowedWikiId !== undefined ? { allowedWikiId } : {}),
  },
};
```

`resolveAllowedWikiId(...)` is still called at each site (it's the source of truth for "is this workspace a project, and what's its wiki"), but its result now flows into `getWorkspaceChatAgent(workspace.id, workspaceContext, effectiveProvider, effectiveModel, allowedWikiId)` instead of into `config.configurable`. The `configurable` object drops the `allowedWikiId` splice entirely — nothing else reads it from there after this change.

---

## Error handling

| Case                                                                 | Behavior                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Project-scoped agent calls any of the 4 write tools with a mismatched `wikiId` | Tool returns `wikiWriteForbiddenMessage(...)` before any write executes; no partial write, no silent failure |
| Same tools called with an unregistered `wikiId`                       | Existing `unknown_wiki` / "not registered" message takes precedence over the forbidden-domain check           |
| `allowedWikiId` is `undefined` (global chat, non-project workspace)   | No restriction — identical to today's behavior                                                                |
| Workspace's `wiki_id` changes via patch                               | `invalidateWorkspaceChatAgent` (already existing) evicts the cached agent; next turn rebuilds with the new restriction |

---

## Testing

- `wiki-write.ts` service-layer tests (existing `wiki-write.test.ts`): unchanged, still pass as-is — the service's contract doesn't change.
- New tests for `wiki-add-cross-link.tool.ts` and `wiki-rebaseline-source.tool.ts`: forbidden-wiki rejection (no mutation occurs), allowed-wiki success, unrestricted when `allowedWikiId` is `undefined` — mirroring the existing `wiki-write.test.ts` cases for the other two tools.
- New/extended `chat-agent.ts` test: the global agent's wiki write tools are unrestricted; a project-workspace agent's are restricted to that workspace's `wiki_id`; a non-project workspace agent's are unrestricted.
- Existing eval scenario `wwrite-005` (`suites/wiki-write.yaml`, wrong-project-wiki rejection) should continue to pass unmodified — it exercises externally observable agent behavior, not tool internals, so this refactor shouldn't change its outcome.

## Evaluations

The guardrail itself is a deterministic value comparison, not model judgment, so it needs no eval. But whether the rejection *message* actually steers the agent to a successful recovery is a model-quality question, and it has a real gap today: `wwrite-005` only judges the agent's explanatory prose after a rejection (via `llm-judge`/rubric) — a corrected retry is scored as "acceptable, and good" but never required, so nothing currently confirms the agent actually completes a working write against the right wiki after being rejected once.

Four new `tool-sequence` scenarios added to the existing `suites/wiki-write.yaml` (no new suite file), one per write-capable tool, each seeding the same rejected attempt shape as `wwrite-005` (wrong `wikiId` → `wiki_forbidden`-shaped message) followed by a user turn confirming to proceed, asserting the agent's next tool call retries with the `wikiId` named in the rejection message:

- `wwrite-006-recovers-after-create-rejection` — `wiki_create_page`
- `wwrite-007-recovers-after-update-rejection` — `wiki_update_page`
- `wwrite-008-recovers-after-cross-link-rejection` — `wiki_add_cross_link`
- `wwrite-009-recovers-after-rebaseline-rejection` — `wiki_rebaseline_source`

Covering all four (not just `wiki_create_page`) matters because each tool's schema differs (`content` vs. `fromPage`/`toPage` vs. `rawFilePath`) — a model that correctly reasons about the corrected `wikiId` for one tool's shape doesn't guarantee it places that correction correctly into a different tool's argument set, especially for the two tools newly guarded by this issue that never had this rejection path before.
