# shell_exec: Configurable env entries via tool settings drawer

**Date:** 2026-09-16
**Issue:** #189 (refs #181, #182)
**Milestone:** v1.9.0 - Workspaces v2

## Problem

The shell_exec tool spawns agent commands with an explicitly constructed, minimal
environment (`PATH`, `HOME`, `USER` only — see `lib/shell-executor/src/config.ts`).
Container-level secrets such as `GH_TOKEN` never reach the child shell, so
authenticated `gh` / `git` commands fail inside shell_exec even though they work in
a plain terminal. Blanket-inheriting `process.env` is rejected: the minimal env is a
deliberate sanitization boundary.

## Solution

Explicit, per-variable opt-in using the existing `@tkottke90/config-manager`
environment-lookup mechanism. The config file stores only the *lookup syntax*
(`${VAR}`); config-manager pulls the actual value from the container environment at
load time via `interpolateEnvVars()` (recursive, runs on `loadConfig()`/`reload()`,
so nested `tools.shell_exec.env` entries are resolved — verified in the issue
thread; no library changes needed).

```yaml
tools:
  shell_exec:
    env:
      GH_TOKEN: "${GH_TOKEN}"
```

### Constraints from config-manager (v1.1.1)

- Interpolation regex: `/\$\{([A-Z_][A-Z0-9_]*)\}/g` — **uppercase only**; the
  `${env:VAR}` form does NOT match and stays a literal string.
- Missing variables resolve silently to `""` (console warning only).
- Schema (`z.record(z.string(), z.string())`) already permits arbitrary entries —
  no schema change.

## Backend

### 1. Env variable name listing

New handler `listAvailableEnvVarsHandler` in
`api/src/routes/v1/tool-settings.handlers.ts`, exposed as
`GET /v1/tool-settings/shell_exec/env-vars` (registered alongside the existing
tool-settings routes).

- Returns `{ names: string[] }` — `Object.keys(process.env)` filtered to names
  matching `[A-Z_][A-Z0-9_]*`, sorted ascending.
- **Names only.** Values are never included in the response, never logged, never
  sent to the client. This is the core security property of the feature.

### 2. Patch validation for `env`

Extend `patchToolSettingHandler` with a shell_exec-specific `env` check (applied
after the existing `ShellExecutorConfigSchema.partial().strict()` parse, when
`toolId === 'shell_exec'` and the patch contains `env`):

- Every **key** must match `[A-Z_][A-Z0-9_]*` → otherwise 400 with a message
  explaining config-manager's uppercase-only limitation.
- Every **value** must match `^\$\{[A-Z_][A-Z0-9_]*\}$` (exactly one lookup, no
  surrounding text) → otherwise 400. This keeps secrets out of config.yaml by
  construction: only lookup syntax is storable via the API.
- Missing-variable re-validation: the handler rejects any referenced variable
  (`${VAR}`) that is not present in `process.env` at save time, listing the
  missing names in the 400 message. (Mitigates config-manager's silent
  empty-string resolution for typo'd names.)

The write path itself is unchanged — validated entries merge into
`tools.shell_exec` via `mergeConfigYaml` and the existing `reload()` callback, and
are interpolated by config-manager on next load.

No changes to `lib/shell-executor`: `spawnCommand` already passes the configured
`env` record wholesale on top of the minimal defaults.

## UI — Shell Exec Tool Settings Drawer

In `ui/src/components/tool-settings-drawer.tsx`, extend the `shell_exec` section
(currently allowlist/denylist only) with an **Environment variables** editor:

- Existing entries render as rows: variable **name** + its read-only lookup value
  (`${NAME}` — syntax only, never a resolved secret). Each row has a remove
  control.
- **Add** is a combobox with type-ahead over the name list fetched from the new
  endpoint. Selecting a name fills both fields with name and `${NAME}`.
- Free-typing an unlisted name is allowed (issue requirement) — the combobox
  accepts custom input; a lowercase name shows an inline warning (it will be
  rejected at save by the backend, and the UI surfaces that error as it does for
  other save failures).
- The value field is editable only in the `${VAR}` shape; the UI never fetches,
  renders, or logs resolved values (it cannot — the API never provides them).

Client types for the new endpoint and the `env` field go in
`ui/src/services/tool-settings-api.ts`.

## Config documentation

`api/config.yaml.example`: document `tools.shell_exec.env` with the `GH_TOKEN`
example and comments covering uppercase-only names, the `${VAR}` shape, and
missing → empty-string behavior.

## Error handling

- 400s from patch validation surface in the drawer's existing `saveError` path.
- A failed env-var fetch (endpoint unavailable) degrades the combobox to
  free-text-only entry; saving still works for valid uppercase names.

## Testing

- **Handler tests** (`tool-settings.handlers.test.ts`):
  - env-vars endpoint returns sorted uppercase names only; a `process.env` value
    never appears in the response.
  - patch with lowercase env key → 400; value not matching `${VAR}` shape → 400;
    reference to an unset variable → 400 naming it; valid entry persists to
    config.yaml (via `mergeConfigYaml`) and survives reload.
- **UI test** (`ui/test/tool-settings-drawer.test.tsx`): env rows render,
  selecting a name from the combobox writes `${NAME}`, remove works, no resolved
  value is ever rendered.
- **Manual acceptance (issue criterion):** with
  `tools.shell_exec.env.GH_TOKEN: "${GH_TOKEN}"` configured, `gh auth status`
  succeeds inside shell_exec; commands without a granted entry still run in the
  sanitized minimal environment.

## Out of scope

- Any change to `lib/shell-executor` or `@tkottke90/config-manager`.
- Auth types / secret managers beyond env lookup (#188 is the analogous MCP work).
- Lowercase variable support (config-manager limitation; surfaced as an error).
