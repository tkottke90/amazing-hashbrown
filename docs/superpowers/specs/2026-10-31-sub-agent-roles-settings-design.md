# Sub-Agent Roles Settings — Design

**Date:** 2026-10-31
**Status:** Draft
**Related:** [#375](https://github.com/tkottke90/amazing-hashbrown/issues/375), [#376](https://github.com/tkottke90/amazing-hashbrown/issues/376) (deferred provider/model routing heuristic), `GLOSSARY.md` §"Sub-Agent Roles" (Role, Default Role), ADR-0048–ADR-0053, [2026-09-09-sub-agent-tooling-design.md](./2026-09-09-sub-agent-tooling-design.md)

---

## Goal

Let a user manage `spawn_sub_agent` Roles (see `GLOSSARY.md`) entirely from Settings — create, edit, delete, and pick a Default Role — with no hand-editing of `config.yaml` required, and no way for the system to end up with zero Roles configured.

## Problem

See issue #375: Roles can currently only be set by hand-editing YAML, there's no UI, and an unconfigured/unknown `role` has no recovery path for either the user or the calling model.

---

## Design

### 1. Config shape

`roles` and `defaultRole` are new fields on the existing `AgentSchema` (`api/src/config/env.ts:467`) — `agent.roles`, `agent.defaultRole` — not root-level `AppConfigSchema` fields. See ADR-0053 for why (the existing `agent.subAgentRecursionLimit` is the precedent). `RoleSchema`/`RolesConfigSchema` keep their current shape (`provider?`, `model?`, `systemPrompt?`, keyed by Role name); `defaultRole` is a new `z.string().optional()` naming one of those keys.

This is a breaking change for any config.yaml that already has a root-level `roles:` block (there's no UI for it today) — no migration shim, per this repo's standing position on backwards-compat hacks.

Role names are slugs: lowercase, hyphen-separated, same convention as an MCP Server's own name. The name is the map key — renaming a Role deletes the old key and inserts a new one.

### 2. API

Dedicated CRUD routes (`roles.route.ts` / `roles.handlers.ts`), following the `tool-settings.handlers.ts` / `mcp-servers.handlers.ts` `HandlerResult<T>` pattern — see ADR-0048:

- `GET /api/v1/roles` — list configured Roles plus the current `defaultRole`.
- `POST /api/v1/roles` — create. Validates against `RoleSchema`; rejects a duplicate name and a `provider` not found among `env.providers` (400 in both cases).
- `PATCH /api/v1/roles/:name` — edit. A `name` change in the body is a rename (delete old key, insert new). Same provider validation as create.
- `DELETE /api/v1/roles/:name` — delete. Rejects deleting the last remaining Role (400) regardless of whether it's the Default (ADR-0050). Deleting a non-last Role that is the current Default clears `defaultRole` to unset rather than auto-promoting another Role.
- `defaultRole` is read/written as part of this same section (e.g. a `PATCH /api/v1/roles/default` or a field on the list/patch payloads — implementation detail, not specified further here) — it must reject naming a Role that doesn't exist.

Handlers read/write the `agent` section of `config.yaml` as a whole (`readConfigYaml`/`mergeConfigYaml` against the `agent` key, merging in just the `roles`/`defaultRole` sub-fields), the same shape `tool-settings.handlers.ts` already uses for `tools.<toolId>`. Each mutating handler calls `configManager.reload()` on success, same as `tool-settings.handlers.ts`/`mcp-servers.handlers.ts`, so a change takes effect without a restart; comment/formatting preservation on write-back is inherited for free from the shared `mergeConfigYaml` machinery every other settings section already uses.

### 3. Boot-time invariant

On boot, if `env.agent.roles` is empty, create one Role automatically: name `default`, no `provider`/`model` override (inherits the system default per §4 below), and set it as `agent.defaultRole` immediately (ADR-0051). This covers both a fresh install and a hand-edited `config.yaml` that dropped to zero Roles between restarts — the same enforcement point as the "at least one Role" invariant (ADR-0050). Because of this, the Settings UI never needs to render a true empty state for the Roles list.

### 4. `spawn_sub_agent` tool changes

- `SpawnSubAgentSchema.role` becomes `z.string().optional()` — omitting it, passing `""`, or passing an unknown name all resolve identically to `agent.defaultRole`.
- When resolution falls back to the Default Role (role was missing/empty/unknown), the tool's returned payload includes a notice naming the Default Role used and listing configured Roles, so the calling model can self-correct on a later call (ADR-0049 territory, but this specific "don't fail silently" choice is its own behavior decision — not an ADR, just implemented as described).
- A Role (including the Default Role) with no `provider`/`model` override continues to resolve via the existing `createProvider()` system-default fallback — never the calling parent thread's own provider/model, even though threads can run on a non-default provider. See ADR-0049. A richer per-scenario routing/heuristic story is deferred to #376.

### 5. UI

A new "Sub-Agents" `Card` on the existing `ui/src/pages/settings/agent-behavior-panel.tsx` page, alongside Background processing / Conversation history / Task board / Observability — not a new `settings-nav.tsx` entry (ADR-0053, supersedes ADR-0052). Its list and add/edit/delete drawer call the `/api/v1/roles` routes directly (own fetch/mutate logic, immediate-commit on save, same shape as `mcp-servers-panel.tsx`/`mcp-server-drawer.tsx`), independent of that page's existing batched save/discard form which continues to own only `afterAgent`/`chat`/`taskBoard`/`observability`.

Form fields: Name (slug, create-time only is editable too per §1), Provider (dropdown of configured providers, reusing `useProviderModelPicker`), Model (dropdown filtered by the selected Provider, same component), System prompt (optional textarea). A "Default" indicator/picker names which configured Role is `defaultRole`.

Error message update per issue #375 §5: when `spawn_sub_agent` is called with an unknown role and no Default Role can be resolved — unreachable after boot-time backfill except via a direct bug — the existing "Configure roles in Settings" message stays as the error path's last resort.

---

## Error Handling & Edge Cases

- **Last-Role deletion attempt:** 400, same `HandlerResult` shape as other settings CRUD rejections.
- **Provider deleted after a Role references it:** no save-time check can prevent this (it happens outside the Roles UI entirely) — the sub-agent run fails at dispatch/build time (`createProvider()` throws), which the existing sub-agent design's error handling already routes through the completion-notification flow as a failure (see [2026-09-09-sub-agent-tooling-design.md](./2026-09-09-sub-agent-tooling-design.md), "Error Handling & Edge Cases").
- **Deleting the current Default Role (not the last one):** succeeds; `agent.defaultRole` becomes unset. The next unknown/empty-role `spawn_sub_agent` call reverts to the pre-#375 "Unknown role, configured roles: ..." error until a user picks a new Default.

## Testing

Standard developer tests per `AGENTS.md` — no eval scenario (this is deterministic config/CRUD/routing, not a new model judgment call):

- `roles.handlers.test.ts`: create/edit/delete validation (name slug rules, duplicate name, unknown provider, last-Role-deletion rejection, Default-clearing-on-delete).
- Boot-backfill test: zero Roles at load → exactly one `default` Role created and set as `defaultRole`.
- `spawn-sub-agent.tool.test.ts` (extended per issue #375 §"Acceptance criteria"): omitted/empty/unknown `role` all resolve to `defaultRole` and the response carries the fallback notice; a configured, known `role` dispatches without a notice.
