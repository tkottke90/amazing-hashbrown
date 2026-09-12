# MCP Server Edit Drawer + Capabilities List — Design

**Date:** 2026-09-12
**Status:** Draft
**Related:** [Issue #117](https://github.com/tkottke90/amazing-hashbrown/issues/117), [PR #167](https://github.com/tkottke90/amazing-hashbrown/pull/167)

---

## Goal

Convert the MCP server Add/Edit modal into a side Drawer (matching the pattern the Skills settings tab already established), and show what a server actually exposes — its tools and resources — directly in that drawer, below the form and above the action buttons.

---

## Problem

`McpServerModal` (`ui/src/pages/settings/mcp-server-modal.tsx`) currently renders as a centered `Modal`. Its only feedback about a server's actual capabilities is a one-line "Connected — found N tools." string produced by the existing "Test connection" button — the user never sees *which* tools, and never sees resources at all, even though the backend's `testMcpConnection` primitive (`lib/tools-manager/src/internal/mcp-client.ts`) already connects to the server and could report far more.

Separately, the Skills settings tab (`ui/src/pages/settings/skill-drawer.tsx`, merged via #168) established a `Drawer`-based edit/create pattern for this Settings page that the MCP servers tab doesn't yet follow, making the two management UIs inconsistent.

---

## Scope

**In scope:**

- Rename/convert `McpServerModal` to a `Drawer`-based `McpServerDrawer`, used for both Add and Edit.
- Extend `testMcpConnection` to also report resources and resource templates, not just tools.
- A new "Capabilities" section in the drawer, between the form fields and the action-button row, listing tools and resources.
- Auto-run the capability probe when the Edit drawer opens (using the server's currently-saved config); keep it manual (via the existing "Test connection" button) for Add mode and for re-checking in either mode.
- The existing inline "Connected — found N tools." text is replaced by the new Capabilities section — one result surface, not two.

**Out of scope:**

- Prompts. The high-level `MultiServerMCPClient` API doesn't expose prompt listing directly (it requires dropping to the raw per-server client via `getClient()`); tools + resources covers the common case and matches what a "Test connection" click already had the connection open for.
- Any change to the list panel's per-row "Check" button/status badge — it stays a simple `Connected — N tools` summary, unrelated to this drawer's richer view.
- Any change to `POST /mcp-servers` CRUD semantics, masking, or the enable/disable flow — untouched by this design.

---

## Design

### 1. Backend — richer `testMcpConnection` result

`lib/tools-manager/src/internal/mcp-client.ts`'s `testMcpConnection` return type changes from:

```ts
{ toolCount: number; toolNames: string[] }
```

to:

```ts
export interface McpCapabilities {
  tools: { name: string; description: string }[];
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  resourceTemplates: { uriTemplate: string; name: string; description?: string }[];
}
```

Built from the same already-connected `MultiServerMCPClient` instance before it's closed: `client.getTools()` for tools (reusing the existing `fetchMcpTools`-style mapping), `client.listResources()` and `client.listResourceTemplates()` for the other two. All three calls run against the one temporary single-server client `testMcpConnection` already constructs; nothing new connects.

`api/src/routes/v1/mcp-servers.handlers.ts`'s `TestConnectionData` type and the two test handlers (`testNewMcpServerHandler`, `testExistingMcpServerHandler`) change to carry `McpCapabilities` instead of `{toolCount, toolNames}`. The route layer's envelope is unchanged: `200 { ok: true, tools, resources, resourceTemplates }` on success, `502 { ok: false, error }` on failure. Nothing outside this feature reads the old shape, so this is a straight replacement.

`ui/src/services/mcp-servers-api.ts`'s `TestConnectionResult` type and `runConnectionTest` change to match — same throw-on-failure behavior as today, just returning the richer object.

### 2. UI — Drawer conversion

`ui/src/pages/settings/mcp-server-modal.tsx` is renamed to `mcp-server-drawer.tsx`, exporting `McpServerDrawer` in place of `McpServerModal`. The only structural change from the current file is swapping `Modal` for `Drawer` (from `@tkottke90/preact-dialog`), `side="right"`, sized similarly to `SkillDrawer` (`sm:w-9/12! sm:max-w-[90vw]!`-style class, adjusted for this form's narrower content). `McpServerForm`'s field markup, signals, `buildConfig()`, and submit handling are unchanged. `mcp-servers-panel.tsx` updates its two call sites (`mode="add"` / `mode="edit"` triggers) to import `McpServerDrawer` instead of `McpServerModal`.

### 3. UI — Capabilities section

A new subcomponent, `McpCapabilitiesPanel`, rendered inside `McpServerForm` between the transport-specific fields and the existing Test-connection/action-button block:

```ts
type CapabilitiesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: McpCapabilities };
```

- `idle`: "Click Test connection to see what this server exposes."
- `loading`: spinner, "Checking…".
- `error`: the failure message (same text the old inline result showed).
- `ready`: two headed lists, **Tools** and **Resources**. Each tool row shows name + description. Each resource row shows name + description (if present) + its `uri` (or `uriTemplate` for a resource template) in monospace, muted. An empty list under either heading reads "No tools exposed." / "No resources exposed." rather than hiding the heading, so the user can tell the probe ran rather than wondering if it's still loading.

This replaces the current `testState`-driven inline paragraph entirely — `testState`'s success/error cases now drive `McpCapabilitiesPanel` instead of a one-line message. The "Test connection" button's `disabled`/spinner behavior while `status === 'checking'` is unchanged; it now maps to `CapabilitiesState`'s `loading`.

### 4. Interaction — when the probe runs

- **Edit mode**: a `useEffect` keyed on the same `openedAt` (`openCount.value`) signal already used to reset transient state runs the probe automatically on open, using `testExistingMcpServer(initial.name, buildConfig())` — i.e. the currently-saved config as seeded into the form, unmasked server-side exactly as "Check"/"Test connection" already do. This is a deliberate, narrow exception to the existing "no auto-connect on page load" principle: opening Edit on one specific, already-configured server is itself a targeted user action, not a passive side effect of viewing Settings — the principle it revisits was about not spinning up every configured server just from opening the settings *page*, which still holds (the list view still never auto-connects).
- **Add mode**: no auto-fetch — nothing is saved yet, so there's nothing meaningful to connect to until the user has filled in fields. Capabilities starts and stays `idle` until the first manual Test connection.
- **Test connection button** (both modes, present today): re-runs the probe against the form's live values, including unsaved edits — identical semantics to today, just populating `McpCapabilitiesPanel` instead of a one-line message.

---

## Error handling

Unchanged from the existing test-connection error handling: a failed probe (add or edit, auto or manual) sets `CapabilitiesState` to `error` with the thrown message, does not close the drawer, and does not block Save. The drawer's own save-error slot (for a failed `onSave`) remains separate and unaffected.

---

## Testing

- **`lib/tools-manager`**: extend `mcp-client.test.ts`'s `testMcpConnection` coverage (already exists as a design point in the prior spec — actual test file to be added alongside implementation) to assert the returned shape includes `tools`/`resources`/`resourceTemplates` arrays.
- **`api`**: extend `mcp-servers.handlers.test.ts`'s `testNewMcpServerHandler`/`testExistingMcpServerHandler` cases — the injected `testFn` stub already used there returns the new shape, and assertions check it passes through unchanged in the `200 {ok:true,...}` body.
- **`ui` (Jest)**: extend `settings-mcp-server-modal.test.tsx` (renamed alongside the component) to cover: Edit-mode auto-fetch firing on open (mocked `testExistingMcpServer` resolves, assert the Tools/Resources lists render), Add-mode NOT auto-fetching (mock not called until the button is clicked), the empty/loading/error/ready `CapabilitiesState` renders, and that Drawer swap doesn't break the existing field-rendering/transport-switch/save tests (those keep working unchanged since `McpServerForm`'s internals aren't changing).
- **e2e**: extend `settings-mcp-servers.spec.ts`'s existing "Check shows the returned tool count" and Edit tests to also assert the drawer (not modal) renders on open, and that the Capabilities section lists a mocked tool/resource name after the (now-mocked) auto-fetch on Edit open.

## Evaluations

Not applicable — no LLM-facing behavior changes.
