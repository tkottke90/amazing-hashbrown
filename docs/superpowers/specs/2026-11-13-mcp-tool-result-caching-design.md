# MCP Tool Result Caching, Disk Persistence, and a Live Resource Ledger — Design

**Date:** 2026-11-13
**Status:** Draft
**Related:** `docs/superpowers/specs/2026-09-08-get-tool-key-tool-design.md`, `docs/superpowers/specs/2026-11-08-get-tool-key-line-range-file-write-design.md`, `docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md`

---

## Goal

A model driving a long MCP-tool-heavy conversation (observed concretely in an n8n-MCP workflow-debugging thread) repeatedly re-calls a read-only MCP tool with the exact same arguments it already called minutes or dozens of steps earlier — paying full MCP round-trip latency and a second content-offload cycle for bytes it already had. The underlying cause isn't model stupidity: `mcpToolToLangChain` (`api/src/agents/chat-agent.ts:293-323`) executes every MCP call unconditionally, offloads anything over `STUB_THRESHOLD_CHARS` to a randomly-keyed, low-salience KV pointer, and nothing in the harness ever tells the model "you already have this." This design adds:

1. An opt-in, per-tool **`cacheable`** setting (plus an optional per-tool **`cacheTtlMs`** override) on the existing tool-settings system, surfaced in the Tool Settings UI.
2. A per-thread **result cache** inside `mcpToolToLangChain` for allowlisted tools: a TTL-bounded dedup keyed on `(boundName, args)`, with an explicit `forceRefresh` escape hatch the model can use when it has reason to believe the resource changed — no attempt to track which mutating calls invalidate which cached reads.
3. Default **disk persistence** of large cached results to a deterministic, overwritable path, piggybacking on the existing `STUB_THRESHOLD_CHARS` offload threshold.
4. A **live resource ledger** — a deterministic (non-LLM-authored) rendering of the cache's current state, injected into the existing workspace context block every turn, so the model doesn't have to scroll back through transcript history to know what it already fetched and where it lives.

---

## Problem

Concretely, in the reviewed transcript: `n8n__get_workflow_details({workflowId: "lKKSEFKICGraxkxH", detailLevel: "full"})` was called at step 13 (offloaded to `kv_5edeae19`, 16,071 chars) and called again, byte-identically, at step 24 — nothing about that workflow had changed in between. Three mechanisms compound to make this likely rather than exceptional:

- `mcpToolToLangChain` has no memoization of any kind — every call hits the real MCP server.
- The offload pointer left behind (`kv_<8 random hex chars>`, via `tool-stub.ts`'s `toolStub()`) carries no relationship to the resource it represents, and is one of dozens of near-identical-looking stubs in a long thread — scanning back to recognize "I already have this" is expensive and unreliable for the model, re-fetching is cheap.
- The only cross-turn continuity mechanism for a long-running workspace thread, `workspace-summarizer.ts`'s `maybeSummarizeWorkspace`, is a one-shot LLM-authored markdown summary (`model.invoke()` over the raw transcript) — prose, not structured data, so even when it fires there's no guarantee a prior fetch's `kv_` key or disk location survives into it.

Nothing in `api/src/agents/system-prompt.ts` instructs the model to check for an existing stub/file before calling a read tool again, either — the existing `get_tool_key` guidance (lines ~1007-1132) is entirely about retrieving content you already know you offloaded, not about recognizing you don't need to re-fetch at all.

---

## Scope

**In scope:**

- `cacheable`/`cacheTtlMs` resolved tool-setting fields, a `getCacheableToolIds()` allowlist builder, and matching Tool Settings UI controls (MCP-category tools only).
- A new per-thread MCP result cache, wired into `mcpToolToLangChain`, with TTL-based staleness, a `forceRefresh` schema addition, and stable `kv_`/disk-path identity across hits and refreshes.
- Default disk persistence of oversized cached results under `.hashbrown/tool-key/`, keyed deterministically, overwritten in place.
- Count-capped eviction added to both the new cache and the existing `tool-content-store.ts` (TTL-based for the former, count-only for the latter).
- A live cache ledger rendered into `buildWorkspaceContextBlock`'s output, capped at a configurable entry count, including stale-but-located entries.
- System-prompt guidance covering `forceRefresh` and how to read the ledger.
- Unit/orchestration test coverage and new eval suite scenarios (see Testing/Evaluations below).

**Out of scope:**

- Caching or wrapping built-in tools (`wiki_search`, `web_fetch`, …) — `mcpToolToLangChain` is the only call site touched; built-ins keep using their original LangChain tool objects (`chat-agent.ts:325`) unmodified. The settings fields exist generically but the UI hides them outside `category: 'mcp'` so the inert state isn't visible.
- Any invalidation scheme that tracks which mutating tool call affects which cached read's resource — deliberately rejected as too tool/server-specific to generalize (see Design §2).
- Cross-thread or per-workspace cache sharing — the cache is strictly per-thread, matching `tool-content-store.ts`'s existing scoping.
- Reading MCP `annotations.readOnlyHint` off the wire — confirmed not available: `fetchMcpTools`/`fromLangChain` (`lib/tools-manager/src/internal/mcp-client.ts:68-118`) build `RegisteredTool` from `@langchain/mcp-adapters`' `DynamicStructuredTool`, which does not surface the MCP spec's own tool annotations. Classification stays a manually-curated, opt-in setting.
- Rendering the ledger for plain chat / task / wiki-ingestion threads that have no workspace context block at all (see §6's note on the three call sites that *do* already exist).

---

## Design

### 1. `cacheable` / `cacheTtlMs` tool settings

`api/src/agents/tool-config.ts`'s `ResolvedToolSettingItem` gains two optional fields, resolved the same way every other field there is — `stored` (a `config.yaml` `ToolEntry` override) wins, with no catalog-level default (every tool starts `cacheable: false`, consistent with "opt-in, not unexpectedly loading the cache"):

```ts
export interface ResolvedToolSettingItem {
  // ...existing fields...
  cacheable: boolean; // default false
  cacheTtlMs: number | null; // default null = "use the global default"
}
```

`resolveToolSettings()`'s `KNOWN_FIELDS` set (line 140) gains `'cacheable'` and `'cacheTtlMs'` so they resolve as first-class fields rather than falling into the `extra` passthrough meant for genuinely tool-specific knobs (`web_fetch`'s own config, etc.).

A new allowlist builder, mirroring `getSubAgentToolIds()`'s shape exactly:

```ts
export function getCacheableToolIds(
  toolsConfig: Record<string, ToolEntry> = env.tools,
  store: ToolSettingsStore = getToolSettingsStore(),
): Set<string> {
  return new Set(
    listResolvedToolSettings(toolsConfig, store)
      .filter((t) => t.category === 'mcp' && t.cacheable)
      .map((t) => t.toolId),
  );
}
```

`category === 'mcp'` is enforced here too, not just in the UI — defense in depth against a stray `config.yaml` edit enabling caching on a built-in tool that has no enforcement wrapper.

`PatchToolSettingSchema` (`tool-settings.handlers.ts:131-138`) gains `cacheable: z.boolean().optional()` and `cacheTtlMs: z.number().int().positive().nullable().optional()` on its generic base object (not `EXTRA_FIELD_SCHEMAS` — these apply across every tool, not one specific tool the way `web_fetch`'s own fields do). `GENERIC_FIELD_NAMES` (line 149) gains both names.

### 2. Per-thread MCP result cache

New module, `api/src/services/mcp-tool-cache.ts`, same spirit as `tool-content-store.ts`:

```ts
interface CacheEntry {
  kvKey: string; // stable for this entry's lifetime
  diskPath: string | null; // stable; null if never crossed the offload threshold
  fetchedAt: number; // epoch ms
  ttlMs: number;
  toolName: string; // boundName
  args: Record<string, unknown>; // for ledger rendering
}

// keyed by `${threadId}:${boundName}:${argsHash}`
const _cache = new Map<string, CacheEntry>();
```

`argsHash` is a stable hash (sorted-key JSON stringify, then a short digest) of the tool's arguments **excluding** `forceRefresh` — `forceRefresh` is a meta-instruction about *this call*, not part of the resource's identity, so `{workflowId: X, forceRefresh: true}` and `{workflowId: X, forceRefresh: false}` must hash identically.

**Staleness is TTL-only, by design.** Round 1 of this design's discussion considered invalidating a cache entry whenever a mutating tool call touched "the same resource," and rejected it: every MCP server's argument shapes differ, there's no generic way to know that `n8n__update_workflow({id: X})` invalidates a cached `n8n__get_workflow_details({workflowId: X})` without hand-writing per-server, per-tool-pair knowledge — exactly the configuration-driven-abstraction trap `AGENTS.md`'s composition-over-customization section warns against. Instead:

- Every cached, allowlisted tool call gets `ttlMs` from the tool's `cacheTtlMs` override (§1) or a new global default, `env.chat.mcpToolCache.ttlMs` (default **5 minutes**, matching `env.chat.mcpToolStub`'s existing config shape).
- Every cacheable tool's schema is extended with an optional `forceRefresh: z.boolean().optional().describe(...)` field (see §3) so the model has an explicit, cheap way to bypass a stale-looking cache the moment it has reason to — e.g. immediately after being told a workflow was just published.

**Stable identity across hits and refreshes.** On a cache hit, the *same* `kvKey` and `diskPath` already stored in the entry are returned — no new `kv_` key is minted, no new disk write happens. On a TTL-expired or `forceRefresh` fetch, the *same* entry object is updated in place (new bytes, new `fetchedAt`) rather than replaced — the model (and the ledger, §6) sees a stable reference to a given resource for the life of the thread, only its freshness and the byte content underneath it change.

**Eviction.** `env.chat.mcpToolCache.threadEntryCap` (default, e.g., 50) bounds entries per thread; insertion past the cap evicts the oldest-`fetchedAt` entry for that thread first. This is a backstop alongside TTL, not the primary staleness mechanism.

### 3. `mcpToolToLangChain` integration

```ts
// cacheableBoundNames is computed once per tool-list build (not per call) via
// toBoundMatchKeys(getCacheableToolIds()) — the same colon-id-to-boundName
// conversion tool-access.middleware.ts and buildSubAgentAgent already use
// (tool-config.ts:269) — and passed in, rather than re-resolved on every
// invocation.
export function mcpToolToLangChain(
  t: RegisteredTool,
  cacheableBoundNames: Set<string>,
  workspaceLocation?: string,
) {
  const cacheable = cacheableBoundNames.has(t.boundName);
  const schema = cacheable ? extendWithForceRefresh(t.parameters) : t.parameters;

  return tool(
    async (args: Record<string, unknown>, config) => {
      const threadId = config?.configurable?.thread_id as string | undefined;
      const { forceRefresh, ...realArgs } = args as { forceRefresh?: boolean };

      if (cacheable && threadId && !forceRefresh) {
        const hit = getCacheEntry(threadId, t.boundName, realArgs);
        if (hit && !isExpired(hit)) return renderFromCache(hit); // no MCP call at all
      }

      const result = await t.execute(realArgs);
      const text = typeof result === 'string' ? result : JSON.stringify(result);

      if (cacheable && threadId) {
        upsertCacheEntry(threadId, t.boundName, realArgs, text, ttlFor(t.boundName), workspaceLocation);
      }

      // existing >STUB_THRESHOLD_CHARS offload logic, unchanged for non-cacheable tools —
      // for cacheable tools, upsertCacheEntry has already handled offload+disk-write with
      // the entry's stable kvKey/diskPath, so this branch reuses that same key rather than
      // minting a second one.
      // ...
    },
    { name: t.boundName, description: t.description, schema },
  );
}
```

`extendWithForceRefresh` calls `.extend({ forceRefresh: ... })` when `t.parameters` is a `ZodObject`, and otherwise (an MCP tool with a non-object top-level schema — not expected in practice, but the allowlist shouldn't assume) logs a warning and treats the tool as **not actually cacheable at runtime**, even if `cacheable: true` is set — caching without a bypass lever would be strictly worse than today's behavior. This degrade-gracefully rule is the only sane choice here, not a tradeoff worth a config knob.

**Signature change:** `mcpToolToLangChain` currently takes only `t: RegisteredTool` (used at `chat-agent.ts:516` via `.map(mcpToolToLangChain)`). That call site becomes `.map((t) => mcpToolToLangChain(t, cacheableBoundNames, workspaceLocation))`, with `cacheableBoundNames` computed once per build from `toBoundMatchKeys(getCacheableToolIds())` and `workspaceLocation` threaded through the same way `makeShellExecTool`/`makeGetToolKeyTool` already are at every call site (`buildChatAgent`, `buildWorkspaceChatAgent`, `buildTaskAgent`, `buildSubAgentAgent`); `buildChatAgent` (no workspace) passes `undefined` for the latter.

### 4. Disk persistence

Reuses `STUB_THRESHOLD_CHARS` (10,000 chars, `tool-stub.ts:11`) as the single trigger — no second threshold. When a cacheable tool's result crosses it **and** a `workspaceLocation` is bound:

```ts
const diskPath = path.join('.hashbrown', 'tool-key', `${t.boundName}_${argsHash}.json`);
await writeToolKeyFile(workspaceLocation, path.basename(diskPath), text); // reuses get-tool-key.tool.ts's existing writer
```

Overwritten in place on every real re-fetch (TTL expiry or `forceRefresh`) — same "silently overwrite, it's scratch space" precedent `get-tool-key.tool.ts:90` already documents for its own `filename` convenience. No versioned history. When there's no `workspaceLocation` (plain chat), the cache still works (KV-only, via the existing `storeToolContent`), it just never gets a `diskPath`.

### 5. `tool-content-store.ts` eviction

`tool-content-store.ts`'s backing `Map` (`_store`, currently unbounded for the life of the process) gets a count cap, **not** a TTL — `get_tool_key`'s whole contract is "fetch this anytime later in the conversation" (the line 1009-1014 system-prompt guidance, and the explicit `web_fetch` promise that a stub is good for later retrieval), and a TTL there would silently break that existing, relied-upon behavior for every other offload producer (`web_fetch`, `wiki-reference-expansion.middleware.ts`, `attachment-resolution.ts`, `summary-boundary.ts`) that has nothing to do with this design. A new `env.chat.toolContentStore.maxEntries` (global, not per-thread — this store isn't thread-scoped today) bounds total size; insertion past the cap evicts oldest-inserted first (a simple insertion-order `Map` already gives FIFO iteration for free).

### 6. Live resource ledger

A new pure function renders a thread's current cache state to text:

```ts
// api/src/services/mcp-tool-cache.ts
export function renderCacheLedger(threadId: string, cap = env.chat.mcpToolCache.ledgerCap): string {
  const entries = listCacheEntries(threadId).slice(-cap); // most-recent `cap`, oldest evicted first
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    const age = Date.now() - e.fetchedAt;
    const status = age > e.ttlMs ? `stale (fetched ${formatAge(age)} ago)` : 'fresh';
    const where = e.diskPath ?? `get_tool_key(threadId, "${e.kvKey}")`;
    return `- ${e.toolName}(${summarizeArgs(e.args)}) — ${status}, at ${where}`;
  });
  return [
    'Resources already fetched this thread (do not re-fetch unless you have a specific reason ' +
      'to believe the underlying data changed — a fresh/stale resource marked here is still ' +
      'faster to re-check than a cold fetch):',
    ...lines,
  ].join('\n');
}
```

This is deterministic and regenerated fresh on every turn — it is **never** part of message history, so it cannot be trimmed by `boundaryAwareTrim`/`recoverTurnOverflow` (`summary-boundary.ts`) and has nothing to do with `workspace-summarizer.ts`'s LLM-authored prose summary. Stale entries stay listed (with their location and age) rather than disappearing at TTL expiry — the whole point is answering a follow-up question asked well outside any sane TTL window, which only works if the ledger still says where the old copy is.

`WorkspaceChatContext` (`chat-agent.ts:593-630`) gains one field:

```ts
cachedResources: string; // pre-rendered by renderCacheLedger(threadId) at the call site, or ''
```

`buildWorkspaceContextBlock` (`chat-agent.ts:632-681`) appends it as one more conditional block, same pattern as `wikiDomain`/`systemPrompt` today — it stays a pure formatter; the actual cache lookup happens at the call site, which already knows its own `threadId`.

**Note on scope:** `buildWorkspaceContextBlock` is called from three places today — `buildWorkspaceChatAgent` (chat-agent.ts:695), `buildTaskAgent` when a `workspaceScope` is present (chat-agent.ts:868), and `buildSubAgentAgent` likewise (chat-agent.ts:1096). The ledger therefore surfaces in all three, each scoped to *that call's own* `threadId` — a task run sees only its own run-thread's cache, never another thread's. This isn't an expansion beyond what was agreed (plain chat, non-workspace task runs, and wiki ingestion still call no such block and get no ledger) — it's the natural, correctly-scoped consequence of hooking into the one function that already exists for this purpose everywhere it already runs.

### 7. Tool Settings UI

`ToolSettingsForm` (`ui/src/components/tool-settings-drawer.tsx:111+`) gains two more signals alongside `enabled`/`includeChat`/etc.:

```tsx
const cacheable = useSignal(tool.cacheable);
const cacheTtlMs = useSignal(tool.cacheTtlMs?.toString() ?? '');
```

...rendered as one more `<Switch>` + a conditionally-shown `<Input type="number">` (same show/hide-on-toggle pattern used elsewhere in this form), submitted as `cacheable`/`cacheTtlMs` in the PATCH body. Per §1, both are rendered **only when `tool.category === 'mcp'`** — showing them for a built-in tool would be a silent no-op until built-ins get their own enforcement wrapper (explicitly out of scope here), which is worse than not offering the control at all.

### 8. System-prompt updates

`api/src/agents/system-prompt.ts` gains:

- A short paragraph (near the existing `get_tool_key`/`WEB_FETCH_SECTION` guidance) explaining the ledger block in the workspace context: resources listed there don't need re-fetching; `forceRefresh` exists for the moment the model has concrete reason to think something changed (the user just told it so, or it just performed the write itself).
- `forceRefresh`'s own field description (set at the schema-extension site in §3, not a separate system-prompt block) teaches the per-call behavior directly, the same way other optional tool args are self-documenting via their Zod `.describe()`.

### 9. New config surface

```ts
// AppConfigSchema additions, env.ts
chat: {
  mcpToolCache: {
    enabled: z.boolean().default(true),
    ttlMs: z.number().int().positive().default(5 * 60 * 1000),
    threadEntryCap: z.number().int().positive().default(50),
    ledgerCap: z.number().int().positive().default(10),
  },
  toolContentStore: {
    maxEntries: z.number().int().positive().default(500),
  },
}
```

`mcpToolCache.enabled: false` short-circuits §2/§3/§6 entirely (falls back to today's unconditional-execute behavior) — same escape hatch shape as the existing `env.chat.mcpToolStub.enabled`.

---

## Testing

- **`mcp-tool-cache.test.ts`** (new): hit/miss by args (including that distinct `detailLevel` values hash differently), TTL expiry transitioning a hit to a miss, `forceRefresh` bypassing a fresh hit, stable `kvKey`/`diskPath` across a hit and across a TTL-driven refresh, per-thread isolation (same tool+args in two threads don't collide), count-cap eviction (oldest-`fetchedAt` first), and `renderCacheLedger`'s fresh/stale labeling and cap behavior — pure-function coverage, no MCP server involved.
- **`tool-config.test.ts`** (updated): `cacheable`/`cacheTtlMs` resolution (stored override wins, default `false`/`null`), `getCacheableToolIds()` filtering to `category: 'mcp'` only.
- **`chat-agent.test.ts`** (updated, orchestration-tagged): `mcpToolToLangChain` skips `t.execute` on a cache hit (spy-verified, not re-asserting cache internals), calls it on a miss/expiry/`forceRefresh`, and the non-`ZodObject`-schema degrade path logs and executes without caching.
- **`tool-content-store.test.ts`** (updated): count-cap eviction, and an explicit regression test that an old-but-not-evicted entry is still readable arbitrarily "later" (no TTL check anywhere in this store).
- **`tool-settings.handlers.test.ts`** (updated): `cacheable`/`cacheTtlMs` round-trip through PATCH, rejection of `cacheTtlMs` on a non-MCP-category tool is *not* special-cased at the handler layer (the UI hides it, but the API itself doesn't need to enforce it — matches how other generic fields already behave).
- **UI (`tool-settings-drawer.test.tsx`, new/updated)**: Cacheable switch + TTL input render only for `category: 'mcp'` rows; submitting patches both fields; TTL input hidden when Cacheable is off.

## Evaluations

This introduces new model-facing behavior — the model is expected to (a) recognize the ledger and stop re-fetching listed resources, and (b) reach for `forceRefresh` specifically when told something changed, not as a default. Per this repo's EDD rules, that needs a failing-first eval before/alongside implementation, not just developer tests:

- A new `suites/mcp-tool-cache.yaml` (or scenarios folded into an existing MCP-tool suite) covering: a seeded ledger entry for a resource, followed by a question answerable from it — asserting the model answers from the ledger/cache rather than re-calling the tool; and a seeded "I just published a new version" user turn immediately after a ledger entry for that same resource — asserting the model calls the tool again with `forceRefresh: true` rather than either blindly trusting the stale entry or re-fetching without the flag.

I can't run `npm run eval` myself (no network path to the local model providers these suites target). Once the scenarios are written, hand off with: `npm run eval -- --suite mcp-tool-cache --model ollama --judge-model ollama`.
