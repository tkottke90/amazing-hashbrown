# Per-Thread and Global Tool Management — Design

**Date:** 2026-09-12
**Status:** Draft
**Related:** [Issue #171](https://github.com/tkottke90/amazing-hashbrown/issues/171)

---

## Goal

Give users control over which tools the Agent can use: a global master list (Settings > Tools) to enable/disable individual tools system-wide, and a per-thread "Edit Tools" drawer to select a subset of the globally-enabled tools for that specific conversation. Along the way, fix a latent reliability gap where one unreachable MCP server can silently take down tool access for every other MCP server too.

---

## Problem

Tool availability today is entirely hardcoded. `buildChatAgent()` (`api/src/agents/chat-agent.ts`) assembles the LLM's tool list as a flat, unconditional array: `STATIC_CHAT_TOOLS` (built-ins: `askUser`, `uploadImage`, wiki reads, `webFetch`, `getToolKey`, `rlmQuery`, `searchSkills`, `searchConversation`, `spawnSubAgent`), `buildGatedTools()` (skill-gated), `buildWikiWriteTools()`, `makeShellExecTool()`, and `loadMcpTools()`. None of these has an on/off switch, globally or per-thread — the only exception is each MCP *server's* own `enabled` flag (`mcp-servers-panel.tsx`, PR #167), which is all-or-nothing for every tool that server exposes.

This causes the concrete problem in the issue: a tool like Pushover can be sitting there, configured and reachable, with no way to make it available to a given conversation when it's actually needed.

There is no existing per-tool metadata (name, description, category, "always on") anywhere in the codebase, no per-thread configuration concept of any kind (threads only carry `provider`/`model` as dedicated columns — no generic config), and today's "Settings > Tools" page (`ui/src/pages/settings/tools-panel.tsx`) is an unrelated form for webFetch/RLM/shell-allowlist settings, which collides on name with what this issue asks for.

**A second, pre-existing gap surfaced during design and is folded into this work:** all enabled MCP servers share one `MultiServerMCPClient`, and tool discovery goes through a single `client.initializeConnections()` call covering every server at once (`lib/tools-manager/src/internal/mcp-client.ts`). `loadMcpTools()`'s `.catch()` around this call is all-or-nothing — there is no per-server isolation anywhere in this path today. One unreachable HTTP/SSE server can plausibly take every other, healthy MCP server's tools down with it for that turn. This is exactly the kind of situation the issue's own motivating example (Pushover unavailable) describes, so fixing it is part of this design rather than a separate follow-up.

---

## Scope

**In scope:**

- A static, in-code tool catalog describing every non-MCP tool (built-in, wiki, skill-gated) with category metadata.
- A new global `tool_settings` store: per-tool `enabled` / `defaultInclude` flags, covering built-in, wiki, skill-gated, and (individually) MCP tools.
- Per-server isolation fix in `lib/tools-manager` so one unreachable MCP server doesn't block tool discovery for other servers.
- A new `Settings > Tools` "Tool Access" section (merged into the existing `tools-panel.tsx`, not a new page) showing the master list grouped by category, with global enable/disable and default-include controls.
- A per-thread `thread_tools` join table + `threads.tools_customized_at` column, REST endpoints, and an "Edit Tools" drawer reachable from the chat window's `+` menu, letting a thread select a subset of the globally-enabled tools.
- Enforcement: a new tool-access middleware in `chat-agent.ts` filtering the assembled tool array down to what's actually allowed for a given thread, at every chat-turn build site that already has a `threadId`.
- Wiki tools are hardcoded always-available and cannot be disabled, globally or per-thread, at any layer.

**Out of scope:**

- Redefining skill-gated tools' actual runtime availability. Today's turn-scoped middleware (`skill-gated-tools.middleware.ts` — a gated tool is available only for the turn its slash command is typed) is untouched. The new UI shows skill-gated tools as **read-only rows** reflecting the backing skill's `enabled` state, for information only; toggling them has no runtime effect and the API rejects writes to them.
- Full per-thread MCP server management (adding/configuring a server scoped to just one thread). MCP servers remain globally configured only (`Settings > MCP Servers`); per-thread selection is limited to choosing among tools already exposed by globally-configured servers.
- Removing or changing the existing per-server `enabled` switch in `mcp-servers-panel.tsx`. It remains a separate, coarser "kill the whole server" control, independent of and ANDed with each tool's own `enabled` flag (see §4).
- `spawn_sub_agent`'s sub-agent tool build path (`buildSubAgentAgent`), which never calls `loadMcpTools()` and uses its own explicit `SUB_AGENT_TOOLS` allowlist today — unaffected by thread-level tool settings.
- Automatic cleanup of stale `tool_settings` rows for MCP tools that have been renamed or removed by a server config change without the server being deleted outright (see §7, Known limitations).

---

## Design

### 1. Tool Catalog — `api/src/agents/tool-catalog.ts` (new)

A static array describing every tool that isn't MCP-sourced:

```ts
interface CatalogEntry {
  toolId: string;
  name: string;
  description: string;
  category: 'built-in' | 'wiki' | 'skill-gated';
  alwaysOn: boolean;           // true only for wiki tools
  skillCommand?: string;        // set for skill-gated entries, matches GATED_SKILL_REGISTRATIONS
}
```

Entries: `webFetch`, `shell_exec`, `spawn_sub_agent`, `ask_user`, `upload_image`, `get_tool_key`, `rlm_query`, `search_skills`, `search_conversation` (category `built-in`); the 5 wiki read tools + 4 wiki write tools (category `wiki`, `alwaysOn: true`); `create_workspace`, `create_project` (category `skill-gated`, cross-referenced from `gated-skill-registrations.ts`).

At boot, every catalog entry is upserted into `tool_settings` (insert-if-missing, never overwriting an existing row) so a new tool added in a future code change automatically gets a settings row with defaults (`enabled: true`, `defaultInclude: true`) — no manual migration step per tool.

### 2. MCP tool discovery — per-server isolation fix

**Problem recap:** `fetchMcpTools()` builds one `MultiServerMCPClient` covering all enabled servers and calls `initializeConnections()` once; a single unreachable server can fail that whole call, and nothing in this repo isolates per-server failures.

**Fix, in `lib/tools-manager/src/internal/mcp-client.ts` / `tools-manager.ts`:** `_ensureMcpInitialized()` fetches per-server instead of through one shared client — either by giving each configured server its own `MultiServerMCPClient` instance, or by wrapping each server's slice of `initializeConnections()`'s result in its own try/catch. A server that fails to connect:

- Contributes zero tools for this fetch (its previously-cached tools, if any, are **not** silently kept stale in the live in-memory list — the middleware relies on the `tool_settings.last_status` field, described below, to represent staleness explicitly rather than the in-memory map silently going out of date).
- Logs a warning (matching today's log-and-continue style) and does not block any other server's tools from loading.
- Marks the server's tools' `tool_settings.last_status = 'unreachable'`. `last_seen_at` is left untouched — it should reflect the last time the tool was actually confirmed reachable, not the last check attempt.

A server that succeeds updates `tool_settings.last_status = 'connected'` and `last_seen_at = now()` for each tool it returned, upserting a row (`category: 'mcp'`, `mcp_server: <name>`, defaults `enabled: true, defaultInclude: true`) for any tool seen for the first time.

This status write-through happens as a side effect of `loadMcpTools()` (called on every chat turn already) and of an explicit "Refresh" action from the UI (§5) — never automatically just from loading a settings page, consistent with the existing MCP Settings UI's stated principle of not causing side effects (spawning processes / opening connections) merely by viewing a page.

### 3. Data model

```
tool_settings                        -- new store, follows BaseStore/migration pattern (thread-store.ts)
  tool_id          TEXT PRIMARY KEY   -- 'webFetch', 'shell_exec', 'mcp:pushover-server:pushover_send'
  category         TEXT               -- 'built-in' | 'wiki' | 'skill-gated' | 'mcp'
  enabled          INTEGER (bool)
  default_include  INTEGER (bool)
  mcp_server       TEXT NULL          -- set for category 'mcp' only
  last_seen_at     TEXT NULL          -- ISO timestamp of last successful discovery
  last_status      TEXT NULL          -- 'connected' | 'unreachable' | NULL (never checked)
  updated_at       TEXT

thread_tools                         -- new join table
  thread_id   TEXT REFERENCES threads(id)
  tool_id     TEXT REFERENCES tool_settings(tool_id)
  PRIMARY KEY (thread_id, tool_id)

threads.tools_customized_at  TEXT NULL   -- new column, new migration in the shared threads/workspace-store numbering
```

- `tools_customized_at IS NULL` → thread has no rows in `thread_tools` and its effective tool set is computed live from global defaults (`tool_settings` where `enabled AND default_include`, plus all `alwaysOn` catalog tools).
- `tools_customized_at IS NOT NULL` → `thread_tools` is authoritative, even if it holds zero rows (a thread can deliberately have no extra tools beyond wiki). Effective set = `thread_tools` joined to `tool_settings`, filtered to still-`enabled`, plus all `alwaysOn` tools.
- Writing a customization **snapshots the full resulting set**, not a diff against defaults: if a user starts from global defaults and disables one tool, what's persisted is every currently-default-included, enabled tool minus that one — not a "some tools removed from defaults" delta. This means a later change to global defaults never silently changes an already-customized thread's behavior.
- Wiki tools are enforced `alwaysOn` in code (the catalog), independent of whatever a `tool_settings` row for them might say — belt-and-suspenders against a future bug that flips `enabled` on a wiki tool's row.
- Deleting an MCP server deletes its `tool_settings` rows and any `thread_tools` rows referencing them outright (the tools no longer exist, as opposed to merely being unreachable).

### 4. Server-level vs. tool-level MCP enable

The existing per-server `enabled` switch (`mcp-servers-panel.tsx`) and each tool's own `tool_settings.enabled` are independent flags that **AND together at runtime** — a disabled server makes all its tools unavailable regardless of their individual flags, but does not overwrite those flags. Re-enabling the server restores exactly the per-tool state the user left it in.

### 5. Backend API

New route pair, following the `mcp-servers.route.ts`/`mcp-servers.handlers.ts` shape (`HandlerResult<T>` idiom):

**`api/src/routes/v1/tool-settings.route.ts` + `tool-settings.handlers.ts`** — global:

| Method  | Path                      | Body                             | Behavior |
|---------|---------------------------|-----------------------------------|----------|
| `GET`   | `/api/v1/tool-settings`   | —                                 | Full merged master list: every catalog entry + every `tool_settings` row of category `mcp`. Each item: `{toolId, name, description, category, enabled, defaultInclude, mcpServer?, lastStatus?, lastSeenAt?}`. Reads cached status only — no live discovery triggered. |
| `PATCH` | `/api/v1/tool-settings/:toolId` | `{enabled?, defaultInclude?}` | 400 if `toolId`'s category is `wiki` (cannot disable) or `skill-gated` (read-only, no runtime effect — rejected rather than silently accepted). 404 if unknown `toolId`. |
| `POST`  | `/api/v1/tool-settings/refresh` | —                            | Triggers a live MCP discovery pass (same call as a chat turn's `loadMcpTools()`), updating `last_status`/`last_seen_at` for all MCP tools, then returns the refreshed list. Explicit user action only (the "Refresh" button), never automatic. |

**Extend `api/src/routes/v1/threads.route.ts` + `threads.handlers.ts`** — per-thread:

| Method   | Path                              | Body                  | Behavior |
|----------|------------------------------------|-----------------------|----------|
| `GET`    | `/api/v1/threads/:id/tools`        | —                     | `{customized: boolean, tools: [...same shape as global, plus `selected: boolean`]}`, computed via the effective-set logic in §3. |
| `PUT`    | `/api/v1/threads/:id/tools`        | `{toolIds: string[]}` | The full resulting set (not a diff). Sets `tools_customized_at = now()`, replaces `thread_tools` rows. Server force-includes all `alwaysOn` tools regardless of what's sent. 400 if any `toolId` is not currently globally `enabled` (rejected, not silently dropped) or unknown. |
| `DELETE` | `/api/v1/threads/:id/tools`        | —                     | Reset to defaults: clears `tools_customized_at` to `NULL` and deletes the thread's `thread_tools` rows. |

### 6. Enforcement — `chat-agent.ts`

A new `createToolAccessMiddleware(enabledToolIds: Set<string>)`, structurally identical to the existing `skill-gated-tools.middleware.ts` (a LangChain `createMiddleware` with `wrapModelCall` filtering `request.tools`). `buildChatAgent`, `buildWorkspaceChatAgent`, and `buildTaskAgent` each already have the `threadId` needed; each calls a new `resolveEnabledToolIds(threadId)` helper (implements the §3 effective-set query) once per build and adds this middleware to the agent's middleware chain, alongside — not replacing — the existing skill-gating middleware. `buildSubAgentAgent` is untouched (§Scope).

### 7. Frontend — Settings > Tools

Extends `ui/src/pages/settings/tools-panel.tsx` with a new "Tool Access" section above the existing Web Fetch / RLM / Shell cards (single page, per the chosen merge approach):

- Grouped list: Built-in, Wiki (rows disabled/always-on, no switch), Skill-Gated (read-only, shows backing skill's enabled state, no switch), MCP (sub-grouped by server, each row with a status dot: green connected / gray unknown / red unreachable, sourced from cached `lastStatus`).
- Each togglable row: name, description, category badge, `enabled` switch (`PATCH .../:toolId`), `default include` checkbox.
- A "Refresh" button at the top of the MCP group triggers `POST .../refresh` and re-renders status dots — the only way this page causes a live connection check.
- Reuses the row/switch/badge visual style from `mcp-servers-panel.tsx`.

### 8. Frontend — Chat window "Edit Tools"

- New `DropdownMenuItem` in `ui/src/components/chat-input.tsx`'s `+` menu (sibling to "Add file"), `onSelect` opens the drawer.
- Controlled-signal drawer pattern (matching `skill-drawer.tsx`, not the per-row-trigger pattern of `mcp-server-drawer.tsx`), via a new `use-thread-tools.ts` hook holding open-state + fetch/save logic, since the menu item can't render its own trigger element in place.
- Same grouped layout as the Settings page, scoped to the current thread: each togglable row's checkbox reflects `selected` from `GET .../:id/tools`; rows for tools that are globally disabled are shown greyed/unchecked with a tooltip ("disabled globally — enable in Settings > Tools") rather than hidden, so the user understands why they can't select it.
- Footer: "Reset to defaults" (`DELETE .../:id/tools`) and "Save" (`PUT .../:id/tools` with the full checked set).

---

## Error handling & edge cases

- **MCP server goes unreachable mid-conversation:** its tools are simply omitted from that turn's assembled tool list (existing log-and-continue behavior, now scoped per-server instead of per-fetch). No error surfaced to the end user; if a thread had it selected, it silently isn't offered that turn, and reappears once the server is reachable again — no action needed from the user.
- **Wiki tool disable attempt** (API or a bug in the UI sending one anyway): rejected server-side (400) regardless of what the client sends; the middleware's own `alwaysOn` inclusion additionally makes this unreachable in practice even if the write somehow got through.
- **Selecting a globally-disabled tool for a thread:** rejected (400) by `PUT .../:id/tools`, not silently dropped — surfaces as a form validation error in the drawer rather than a silent no-op.
- **MCP server deleted while a thread has it selected:** `thread_tools` rows for that server's tools are deleted along with `tool_settings` (§3); the thread's next `GET .../tools` simply no longer lists them.
- **Renamed MCP tool** (server starts exposing a different tool name for what was conceptually the same capability): treated as a brand-new `tool_id`; the old row goes stale (`last_status` frozen at whatever it last was, `last_seen_at` stops advancing). No automatic cleanup in this pass — see Known limitations.

**Known limitations (accepted, not fixed in this pass):**

- Stale `tool_settings` rows for MCP tools that were renamed (rather than removed via server deletion) are not automatically pruned. A manual "prune stale MCP tool settings" affordance is a reasonable follow-up but isn't required for this issue's acceptance criteria.

---

## Testing

- **`lib/tools-manager`**: unit tests for the per-server isolation fix — one server configured to fail, one to succeed, both in the same `getTools()` call, asserting the healthy server's tools are still returned and the failing one doesn't throw or block them.
- **`api/src/services/tool-settings-store.test.ts`** (new): migration test (new column/tables created cleanly against an existing `threads` DB fixture), catalog seeding idempotency (re-running boot doesn't duplicate or overwrite rows), effective-set query for both customized and non-customized threads.
- **`api/src/routes/v1/tool-settings.handlers.test.ts`** and **`threads.handlers.test.ts`** additions: global PATCH rejecting wiki/skill-gated writes, per-thread PUT rejecting a globally-disabled `toolId`, DELETE resetting `tools_customized_at`, refresh endpoint updating cached status.
- **`api/src/agents/tool-access.middleware.test.ts`** (new): given various global + thread state combinations, verify the filtered tool list is exactly the expected set — always-on tools present regardless of settings, globally-disabled tools absent even if thread-selected, skill-gated tools' inclusion untouched by any of this.
- **UI (Jest)**: `tools-panel.test.tsx` additions for the new Tool Access section; `thread-tools-drawer.test.tsx` (new) for toggle wiring, the globally-disabled-greyed-out state, and save/reset actions hitting the right endpoints.
- **E2E (Playwright)**: one `@user-workflow` spec — open a thread, open Edit Tools, disable a built-in tool, save, verify a subsequent turn's available-tools reflect it (via a mocked/asserted request), reset to defaults, verify it reverts. Mocked network per `e2e/AGENTS.md` conventions.

## Evaluations

Not applicable in the EDD sense (`AGENTS.md` §Evaluation-Driven Development) — this changes *which* tools are mechanically present in a given turn's tool array, not the model's reasoning or behavior given a fixed tool set. There's no new or changed system-prompt content and no new expected model behavior to validate against real model output; the correctness surface here is entirely deterministic filtering logic, covered by the unit/integration tests above.
