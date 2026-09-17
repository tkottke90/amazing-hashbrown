# shell_exec env entries in the Tool Settings drawer — Implementation Plan

**Date:** 2026-09-16
**Spec:** [`docs/superpowers/specs/2026-09-16-shell-exec-env-entries-design.md`](../specs/2026-09-16-shell-exec-env-entries-design.md)
**Issue:** [#189](https://github.com/tkottke90/amazing-hashbrown/issues/189)

Each step is a self-contained unit: implementation + its own tests. Run `npm run lint`, `npx prettier --check .`, and `npm test` (in the touched workspace: `api` for Steps 1–3, `ui` for Step 4) after each step before moving to the next.

Verified against the current code (2026-09-16): `EXTRA_FIELD_SCHEMAS` + `patchToolSettingHandler` in `api/src/routes/v1/tool-settings.handlers.ts`, route registration in `api/src/routes/v1/tool-settings.route.ts`, drawer save path in `ui/src/components/tool-settings-drawer.tsx`, client types in `ui/src/services/tool-settings-api.ts`.

---

## Step 1 — `env` validation in `patchToolSettingHandler`

**Files:** `api/src/routes/v1/tool-settings.handlers.ts`

Add two exported helpers (kept module-level so tests can reuse them) and a
post-parse validation pass:

```typescript
// config-manager interpolation only matches
// /\$\{([A-Z_][A-Z0-9_]*)\}/g — lowercase names stay literal strings.
export const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
// Exactly one lookup, no surrounding text — keeps secrets out of
// config.yaml by construction: only `${VAR}` syntax is storable via the API.
export const ENV_VALUE_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function validateShellEnv(
  env: Record<string, unknown>,
): Record<string, string> | HandlerFailure { ... }
```

In `patchToolSettingHandler`, after `parsedExtra` succeeds for `shell_exec`:

1. If the parsed extra contains `env`, run `validateShellEnv` on it:
   - every **key** must match `ENV_VAR_NAME_RE` → 400 naming the offending
     key and explaining config-manager's uppercase-only limitation;
   - every **value** must match `ENV_VALUE_RE` → 400 with the expected
     `${VAR}` shape;
   - the referenced variable (`$1` of the value match) must exist in
     `process.env` → 400 listing missing names (mitigates config-manager's
     silent empty-string resolution for typo'd names).
2. On failure, return `badRequest(...)` immediately (do not write). Merge
   only the validated entries into `validatedExtra.env`.

No schema change: `ShellExecutorConfigSchema.env` is
`z.record(z.string(), z.string())` and already permits the entries. No change
to `mergeConfigYaml` usage or the reload callback.

**Tests** (extend `api/src/routes/v1/tool-settings.handlers.test.ts`, new
`describe('shell_exec env patch validation (issue #189)')` block):

- `env` with a lowercase key (`gh_token`) → 400, message names the key.
- `env` with a plain value (`abc123`) or a non-`${VAR}` value
  (`Bearer ${GH_TOKEN}`) → 400, message mentions the `${VAR}` shape.
- `env` referencing an unset variable (`${DOES_NOT_EXIST_XYZ_9}`) → 400
  listing the name; set it via `process.env` in the test and the same patch
  succeeds.
- Valid patch (`GH_TOKEN: '${GH_TOKEN}'`) writes to config.yaml (assert via
  `readConfigYaml` on the test config dir) and the response's `env` field
  contains the entry.

## Step 2 — `GET /v1/tool-settings/shell_exec/env-vars` endpoint

**Files:** `api/src/routes/v1/tool-settings.handlers.ts`,
`api/src/routes/v1/tool-settings.route.ts`

Handler (names only — values are never included, logged, or sent):

```typescript
export function listAvailableEnvVarsHandler(): HandlerResult<{ names: string[] }> {
  const names = Object.keys(process.env)
    .filter((name) => ENV_VAR_NAME_RE.test(name))
    .sort((a, b) => a.localeCompare(b));
  return ok({ names });
}
```

Route registration in `tool-settings.route.ts`, **before** the `/:toolId`
routes so Express doesn't route `env-vars` through the param path:

```typescript
toolSettingsRouter.get('/shell_exec/env-vars', (_req, res) => {
  const result = listAvailableEnvVarsHandler();
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
```

**Tests** (same test file, `describe('env var name listing (issue #189)')`):

- response contains sorted uppercase names; a seeded lowercase var
  (`lowercase_var`) is filtered out.
- a seeded var's **value** never appears anywhere in the serialized response
  (assert on `JSON.stringify` of the result).

## Step 3 — document the pattern in `api/config.yaml.example`

**Files:** `api/config.yaml.example`

Inside the `tools:` section (next to the existing `shell_exec` example if
present, otherwise at its documented position), add:

```yaml
shell_exec:
  # Optional: extra env vars passed to shell_exec child commands, on top
  # of the sanitized minimal environment (PATH/HOME/USER).
  # Values must be config-manager env lookups: "${VAR}" — uppercase names
  # only; a missing variable resolves to an empty string.
  env:
    GH_TOKEN: '${GH_TOKEN}'
```

**Tests:** none (example file). Verify by loading the API with a scratch
config containing the block: `shell_exec` tool settings resolve, and
`gh auth status` inside shell_exec succeeds when `GH_TOKEN` is set
(manual acceptance criterion for #189).

## Step 4 — Environment variables editor in the Shell Exec drawer

**Files:** `ui/src/components/tool-settings-drawer.tsx`,
`ui/src/services/tool-settings-api.ts`

Client API (`tool-settings-api.ts`):

- Add `env?: Record<string, string>` to the `shell_exec` member of the
  `ToolSettingPatch` union type (it flows through the generic
  `Partial<...>` already).
- New function:

```typescript
export async function fetchShellEnvVarNames(): Promise<string[]> {
  const res = await fetch('/v1/tool-settings/shell_exec/env-vars');
  if (!res.ok) throw new Error('Failed to fetch environment variable names');
  const data = (await res.json()) as { names: string[] };
  return data.names;
}
```

Drawer (`tool-settings-drawer.tsx`), extending the existing `shell_exec`
section (after the allowlist/denylist fields, ~line 330):

- Local state: `envEntries` — a `useSignal<{ name: string; value: string }[]>`
  initialized in the `openedAt` reset effect from `tool.env ?? {}` (render the
  value read-only — it's only ever `${NAME}` syntax, never a resolved secret);
  `envNameQuery` for the combobox; `envWarn` for inline warnings.
- **Rows:** one per entry — name label, read-only `${NAME}` value, remove
  button (updates `envEntries`).
- **Add combobox:** on drawer open (and on first focus), call
  `fetchShellEnvVarNames()`; failure degrades silently to free-text-only
  (per spec's error-handling section). Filter the fetched names by the typed
  query, excluding names already added. Selecting a name appends
  `{ name, value: \`$\{name\}\` }` and clears the query. Free-typing an
  unlisted name is allowed: Enter appends it with value `` `${typed}` ``; if
it doesn't match `^[A-Z_][A-Z0-9_]*$` show the inline warning text
  ("config-manager only supports uppercase names — save will be rejected").
- **Save:** in the `tool.toolId === 'shell_exec'` branch of `handleSave`,
  add:

```typescript
if (envEntries.value.length > 0) {
  patch.env = Object.fromEntries(envEntries.value.map((e) => [e.name, e.value]));
}
```

(An empty list omits the field — no accidental wipe of pre-existing file
entries; removal of individual entries still works because untouched rows
stay in the list.) Backend 400s surface through the existing `saveError`
path unchanged.

- The UI never fetches, renders, or logs resolved values (the API never
  provides them).

**Tests** (extend `ui/test/tool-settings-drawer.test.tsx`, new
`describe('shell_exec env editor (issue #189)')`):

- existing `env` entries render as rows with name + read-only `${NAME}`
  value; remove works.
- combobox: selecting a fetched name appends a row with value `${NAME}`;
  mocked `fetchShellEnvVarNames` failure → typing a name still appends it.
- lowercase typed name shows the uppercase warning; the outgoing patch
  payload still only ever contains `${VAR}`-shaped values (assert on the
  `patchToolSetting` mock's calls — no env **value** ever appears).
