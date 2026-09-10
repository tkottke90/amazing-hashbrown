# MCP Servers Settings UI — Design

**Date:** 2026-09-10
**Status:** Draft
**Related:** [Issue #117](https://github.com/tkottke90/amazing-hashbrown/issues/117)

---

## Goal

Replace the `PlaceholderPanel` currently rendered for the `mcp-servers` tab on the Settings page with a real management UI: view, add, edit, remove, and enable/disable MCP server configurations, plus a way to validate a server's connection before and after saving it.

---

## Problem

The `mcp-servers` case in `ui/src/pages/settings/index.tsx` renders `<PlaceholderPanel title="MCP Servers" />`, which only shows "Management UI coming soon." There is no way to configure MCP servers from the UI today, even though the backend already has full CRUD support for them:

- `ToolsManager` (`lib/tools-manager/src/tools-manager.ts`) has `addMcpServer`, `editMcpServer`, `removeMcpServer`, `listMcpServers`, and `importMcpConfig`, all of which persist to `mcp.json` (via `readMcpConfig`/`writeMcpConfig` in `lib/tools-manager/src/internal/mcp-config.ts`) and immediately reset the live `MultiServerMCPClient` (`_resetMcpClient`) so changes take effect right away.
- `McpServerConfig` (`lib/tools-manager/src/types.ts`) already models both `stdio` and `http`/`sse` transports.
- No REST route exposes any of this today. The `'mcp-servers'` entry in `SETTINGS_SECTIONS` (`api/src/routes/v1/settings.handlers.ts`) is a stub: `{ get: () => ({}), readOnly: true }`.
- `McpServerConfig` has no enable/disable flag, so "enable/disable an MCP server" (an explicit requirement in the issue) requires a small type/behavior addition.

---

## Scope

**In scope:**

- View, add, edit, remove, and enable/disable MCP servers from the Settings → MCP Servers tab.
- A "test connection" capability: check whether a given server config (saved or still being edited) can actually connect, and how many tools it exposes.
- New `enabled` field on `McpServerConfig`, enforced when building the live MCP client.
- Secret masking for `env`/`headers` values, consistent with the existing `apiKey` masking pattern.
- New dedicated REST routes for MCP server CRUD + test, replacing the `mcp-servers` settings-section stub.

**Out of scope:**

- Bulk import of an existing `mcp.json` from the UI. `ToolsManager.importMcpConfig` already supports this at the library level, but no UI is added for it in this pass — CRUD only, matching the issue text.
- Any auto-triggered connection status check (e.g. on panel mount). Status is checked only on explicit user action ("Check" button), so opening Settings never has the side effect of spawning stdio processes or opening network connections.
- Any change to how the chat agent selects/filters which MCP tools it uses at runtime beyond respecting `enabled`.
- The companion Skills tab placeholder (tracked separately per the issue's "Related" note).

---

## Design

### 1. Data model — `lib/tools-manager/src/types.ts`

Add `enabled?: boolean` (default `true` when absent) to both transport variants:

```ts
export interface McpStdioConfig {
  transport?: 'stdio';
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  restart?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export interface McpHttpConfig {
  transport: 'http' | 'sse';
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  reconnect?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}
```

`buildMcpClient` (`lib/tools-manager/src/internal/mcp-client.ts`) filters `config.mcpServers` to entries where `enabled !== false` before constructing the `MultiServerMCPClient`. This is the single chokepoint already called by `boot()`, every CRUD mutation (via `_resetMcpClient`), and `importMcpConfig` — no other call site needs to know about `enabled`.

### 2. Secret masking

`env` (stdio) and `header` (http/sse) values are masked the same way the existing `apiKey` field is masked today (`maskApiKey`/`unmaskApiKey` in `api/src/routes/v1/settings.handlers.ts`): every value is replaced by a fixed sentinel string on the way to the client, and restored from the stored config on the way back in if the client echoes the sentinel unchanged. This is a blanket per-value policy — no attempt to guess which keys are "secret-shaped" — matching the one existing precedent in this codebase and keeping the rule simple and predictable.

A new shared helper, `unmaskMcpSecrets(draft: McpServerConfig, stored: McpServerConfig): McpServerConfig`, walks `env`/`headers`: any value still equal to the mask sentinel is replaced with the corresponding value from `stored`; anything else (a new key, or a changed value) passes through as given. This helper is used by two call sites (below): saving an edit, and testing an edit's draft before saving.

### 3. Connection testing

A new function in `lib/tools-manager/src/internal/mcp-client.ts`:

```ts
export async function testMcpConnection(
  config: McpServerConfig,
): Promise<{ toolCount: number; toolNames: string[] }>;
```

Builds a single-server `MultiServerMCPClient` from one config (reusing `buildMcpClient`/`fetchMcpTools` machinery, scoped to one entry), calls `initializeConnections()`, collects the tool names, and always closes the client afterward — regardless of success or failure. Throws on connection failure; the caller translates that into a result object rather than an HTTP error (see §4).

This one primitive backs both testing flows in the API:

- Testing a brand-new, unsaved server (Add modal): the draft config is plaintext (nothing has ever been masked), so it's passed to `testMcpConnection` as-is.
- Testing an existing server's current-or-edited config (Edit modal, and the list's per-row "Check" button): the draft may still contain masked placeholders for fields the user hasn't touched. It's run through `unmaskMcpSecrets(draft, stored)` first, then passed to `testMcpConnection`. This is what lets "Test connection" validate exactly what's on screen, including in-progress unsaved edits — not just the already-saved config.

Nothing from a test is persisted; it's purely a read-through connection probe.

### 4. Backend API — `api/src/routes/v1/mcp-servers.route.ts` + `mcp-servers.handlers.ts`

New route pair mounted at `/api/v1/mcp-servers`, following the `workspaces.route.ts`/`workspaces.handlers.ts` shape: thin Express routes delegate to handlers returning a `HandlerResult`/`HandlerFailure` (reusing the existing type from `threads.handlers.ts`), routes map that to status/JSON.

| Method | Path | Body | Behavior |
|---|---|---|---|
| `GET` | `/` | — | `{ name, config }[]` from `toolsManager.listMcpServers()`, secrets masked |
| `POST` | `/` | `{ name: string, config: McpServerConfig }` | `addMcpServer`; 400 on invalid shape (missing `name`/`command`/`url`, invalid `transport`); 409 if `name` already exists |
| `PATCH` | `/:name` | `Partial<McpServerConfig>` | Runs `unmaskMcpSecrets(body, stored)`, then `editMcpServer`; 404 if `name` doesn't exist. Also used for the enable/disable toggle (`{ enabled: false }`) |
| `DELETE` | `/:name` | — | `removeMcpServer`; 404 if `name` doesn't exist |
| `POST` | `/test` | full draft `McpServerConfig` (plaintext) | Calls `testMcpConnection` directly; used by the Add modal |
| `POST` | `/:name/test` | full draft `McpServerConfig` (may contain masked placeholders) | 404 if `name` doesn't exist; otherwise `unmaskMcpSecrets(body, stored)` then `testMcpConnection`; used by the Edit modal and the per-row "Check" button |

**Test endpoints never return an HTTP error for a failed connection.** `POST /test` and `POST /:name/test` return `200 { ok: true, toolCount, toolNames }` or `200 { ok: false, error }` — "the target server is unreachable" is an expected, common outcome of a check the user is deliberately running, not a malformed-request or server bug. A 4xx/5xx from these routes is reserved for an actually bad request (unknown `:name`, malformed body).

The `'mcp-servers'` entry is removed from `SETTINGS_SECTIONS` in `settings.handlers.ts` — this tab no longer goes through the generic settings-section GET/PATCH machinery at all.

**Why not the generic settings-section pattern:** other panels (Model Providers, Tools) load a whole section into a local form and PATCH the entire object on a page-level "Save," which assumes batched, staged edits. `ToolsManager`'s existing methods are already per-entity and apply-immediately (each write persists to disk and reconnects the live client on its own). Building batched staging on top of that would mean reworking `ToolsManager` to support "stage many changes, commit once" — real backend churn the issue doesn't ask for. A dedicated CRUD resource, one call per user action, is the smaller and more honest fit — and it matches the `workspaces` resource precedent already in this codebase.

### 5. Frontend — `ui/src/pages/settings/`

**`index.tsx`**: `mcp-servers` case renders `<McpServersPanel />` instead of `<PlaceholderPanel title="MCP Servers" />`.

**`mcp-servers-panel.tsx`** (new): fetches the list on mount (`GET /`) into a local signal (no `useSettingsSection` — this panel has no page-level Save/Discard; every action calls its own endpoint immediately and refreshes from the response). Renders:

- A card with header ("MCP Servers" + "Add server" button opening `McpServerModal` in `add` mode).
- One row per server: name, a transport badge (`stdio`/`http`/`sse`), an enabled/disabled toggle switch (fires `PATCH /:name` with `{ enabled }` on change), a status badge starting at `Not checked` (values: `Not checked` / `Checking…` / `Connected (N tools)` / `Error: <message>`), a "Check" button (calls `POST /:name/test` with the row's current — masked — config, since `unmaskMcpSecrets` server-side restores it), an "Edit" button (opens `McpServerModal` in `edit` mode with the row's config), and a "Remove" button behind a confirm step.
- Every mutating action shows a toast (`showToast`) on failure; on success the panel re-fetches the list from the server rather than splicing state locally, so masked secrets and any server-normalized fields stay correct.

**`mcp-server-modal.tsx`** (new), structured like `provider-modal.tsx` (a `Modal` trigger + form component keyed by an `openCount` signal so re-opening resets state):

- Name field, disabled in `edit` mode (same convention as `ProviderModal`'s provider name).
- Transport selector (`stdio` / `http` / `sse`) switching the field set below it:
  - **stdio**: command, args (textarea, one per line → array, same pattern as `tools-panel.tsx`'s allowlist/denylist), working directory, env vars (key/value repeatable rows), restart settings (enabled checkbox + max attempts + delay).
  - **http/sse**: URL, headers (key/value repeatable rows), reconnect settings (enabled checkbox + max attempts + delay).
- Enabled checkbox, defaulting to checked for new servers.
- "Test connection" button: calls `POST /test` (add mode) or `POST /:name/test` (edit mode) with the form's current values; shows a spinner then an inline success (tool count) or error result inside the modal. Does not block or auto-trigger Save.
- Save button: `POST /` (add) or `PATCH /:name` (edit); on success, closes the modal — the panel's post-save refetch (above) picks up the new/updated row.

**`key-value-list.tsx`** (new, shared): a small presentational component for repeatable key/value rows with add/remove-row controls and `type="password"` value inputs (matching the `apiKey` field's treatment in `provider-modal.tsx`). Used identically for `env` and `headers` — one component, two call sites, rather than duplicating repeatable-row logic.

---

## Error handling

- **Backend**: standard `HandlerFailure` statuses — 400 (invalid shape), 404 (unknown `:name` for edit/delete/test), 409 (duplicate name on create). Test endpoints are the one deliberate exception: a failed connection is a `200` with `ok: false`, not an HTTP error (see §4).
- **Frontend**: mutating actions (add/edit/remove/toggle) show a toast and leave state unchanged on failure so the user can retry. The modal's inline test result has its own dedicated success/error slot rather than a toast, since a failed test is an expected, non-exceptional outcome.

---

## Testing

- **`lib/tools-manager`**: unit tests for `testMcpConnection` (success returns tool count/names; failure rejects, and the client is always closed), `unmaskMcpSecrets` (unchanged fields substituted from stored, changed fields kept as given, new keys pass through untouched), and the `enabled` filter in `buildMcpClient` (a server with `enabled: false` is excluded from the constructed client). Extends the existing `tools-manager.test.ts`/`mcp-config.test.ts` coverage.
- **`api/src/routes/v1/mcp-servers.handlers.test.ts`** (new): orchestration tests per the `workspaces.handlers.test.ts` pattern — CRUD happy paths, 404/409 error cases, secret masking on `GET`, the unmask-merge on `PATCH` and on `POST /:name/test`, and the `ok: false` (not an HTTP error) shape for a failed test — all against a stubbed `ToolsManager`/`testMcpConnection`, no real MCP connections.
- **UI (Jest)**: `mcp-servers-panel.test.tsx` and `mcp-server-modal.test.tsx` — list rendering, add/edit/remove/enable-toggle wiring to the correct endpoints, and the test-connection button's three states (idle/checking/result).
- **E2E (Playwright)**: one `@user-workflow` spec exercising add → appears in list → toggle off → edit → Check shows a status badge → remove, with all requests mocked via `page.route()` (per `e2e/AGENTS.md`) since no real MCP server is available in CI. Tagged `@functional`/`@user-workflow` consistent with existing specs.

## Evaluations

Not applicable — this feature has no LLM-facing behavior (no new/changed tool, no system-prompt change, no effect on what the model sees or decides). The EDD requirement in `AGENTS.md` applies to model-facing behavior changes, which this isn't.
