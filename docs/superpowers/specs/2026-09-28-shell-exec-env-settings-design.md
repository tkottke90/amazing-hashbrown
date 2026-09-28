# Shell Exec Env Settings — Design

**Date:** 2026-09-28
**Status:** Approved
**Related:** [Issue #220](https://github.com/tkottke90/amazing-hashbrown/issues/220), [Issue #189](https://github.com/tkottke90/amazing-hashbrown/issues/189) (introduced the env editor), [Tool settings redesign](./2026-09-13-tool-settings-redesign-design.md)

---

## Goal

Make the Shell Exec tool configurable from **Settings → Tools** again: saving must succeed, env var errors must name the row and the fix, resolved secrets must never reach the UI, and adding an env var must not strip `PATH` from shell commands.

---

## Problem

Saving Shell Exec settings fails with:

```
Invalid value for environment variable "PATH": must be exactly one env lookup in the form "${VAR}" — secrets are never written to config.yaml, only the lookup syntax is.
```

Four defects combine here:

1. **The settings API reads interpolated values.** `GET /api/v1/tool-settings` builds its response from `env.tools`, which comes from config-manager's `getSection()`. config-manager runs `interpolateEnvVars()` when it loads, so `getSection()` returns resolved values. `${GH_TOKEN}` reaches the drawer as the real token and is shown in plain text. `${PATH}` (or a literal `PATH`) reaches it as `/usr/local/bin:…`. `PATCH` reads and writes the **raw** file (`readConfigYaml`/`mergeConfigYaml`) and its response comes from raw data, so `GET` and `PATCH` disagree about what the data is.
2. **Saving resends resolved values, and they fail validation.** The drawer loads every `tool.env` entry into `envEntries` and sends them all back on save. `validateShellEnv` accepts only `^\$\{[A-Z_][A-Z0-9_]*\}$`, so the resolved `PATH` is rejected. The handler stops at the first bad entry, and its error doesn't say what to do.
3. **Configured env replaces the defaults.** `ShellExecutorConfigSchema` sets `PATH/HOME/USER` only as a Zod `.default()`. Once `env` holds anything (e.g. `{ GH_TOKEN }`), commands start with no `PATH` and `gh` can't be found. That contradicts `api/config.yaml.example`, which says user env is added "on top of" the minimal environment.
4. **Drawer UX bugs.**
   - The name input's `list="shell-env-var-names"` doesn't match the datalist's `id="shell-env-vars-datalist"`, so suggestions never show.
   - A row can only be added with Enter.
   - `${GH_TOKEN}` is accepted as a _name_.
   - Removing the last row is silently undone, because an empty list leaves `env` out of the save.

---

## Decisions

| Question                                   | Decision                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env values                                 | **Lookups, literals, or a mix.** Any string is allowed. `${UPPER}` references are filled in by config-manager as before. This drops #189's lookup-only rule on purpose. |
| Guard against a secret pasted as a literal | **None.** The drawer's helper text states that literals are saved to config.yaml as plain text.                                                                         |
| Default `PATH/HOME/USER`                   | **Hidden, can be overridden.** Always present when a command runs. A user row with the same name wins. Not shown in the drawer.                                         |
| Approach                                   | **Raw read path + plain-text value.** No change to the storage format (rejected: typed `{kind, value}` rows). Values stay readable (rejected: write-only env).          |

---

## Design

### 1. API: read and write the same data

**Read.** `listToolSettingsHandler(configDir)` builds its list from `readConfigYaml(configDir).tools`, checked against `ToolsConfigSchema`, and no longer uses `env.tools`. The route passes `configManager.getConfigDir()`. If the raw file fails validation, the handler falls back to `{}` and logs a warning, matching the `env.tools` getter.

- `patchToolSettingHandler`'s existence check (`findResolved`) only needs the catalog entry and is unaffected.
- Runtime consumers (resolver defaults for agents, `shell-exec.tool.ts`, `api/src/index.ts`) keep reading the filled-in `env.tools`. **Only the settings API switches to the raw file.**

**Write validation (`validateShellEnv`)**:

- Name: must match `ENV_VAR_NAME_RE` (`^[A-Z_][A-Z0-9_]*$`).
- Value: any string.
- Every `${NAME}` where NAME matches `[A-Z_][A-Z0-9_]*` must be present in `process.env`. A missing variable would silently become `""` at load time.
- Lowercase `${foo}` is left alone (config-manager treats it as a literal).
- Every entry is validated. All failures are collected, not only the first.
- `ENV_VALUE_RE` (the single-lookup rule) is removed and replaced with a global reference regex.

**Error format.**

- `HandlerFailure` gets an optional `fieldErrors?: Array<{ field: 'env'; key: string; message: string }>`.
- The route sends back `{ error, fieldErrors }`. `error` is a one-line summary, e.g. `2 environment variables are invalid.`
- Messages name the row and the fix, and **never include the value**:
  - `gh_token: names must be uppercase letters, digits or _ (e.g. GH_TOKEN).`
  - `PATH: references ${FOO}, which isn't set in the API's environment. Set it and restart the API, or remove the reference.`
- `env: {}` is valid and clears the stored entries (the existing merge `{ ...currentEntry, ...validatedExtra }` overwrites `env`).

### 2. Running commands: user entries go on top of the defaults

- `lib/shell-executor/src/config.ts`: export `defaultShellEnv()`, which returns today's `PATH/HOME/USER` values. The schema's `env` default becomes `{}`.
- `lib/shell-executor/src/shell-executor.ts` `spawnCommand`: `env: { ...defaultShellEnv(), ...config.env }`.

The merge happens **when the command starts**, not in a Zod `.transform()` or `.default()`. The settings `PATCH` validates with `ShellExecutorConfigSchema.partial().strict()`, so a schema-level merge would write the host's literal `PATH/HOME/USER` into config.yaml on every save.

Existing configs:

- **No `env`:** same as today.
- **`env` with only lookups:** gains `PATH/HOME/USER` (bug fix).
- **`env` that sets its own `PATH`:** unchanged.

Update the `env` comment in `api/config.yaml.example`: user entries go on top of the defaults, a row with the same name overrides a default, values may be `${VAR}` lookups or literals, and literals are stored in plain text.

### 3. Drawer UI (`ui/src/components/tool-settings-drawer.tsx`)

- **Existing rows:** the name is a label; the value is an editable text input (it's display-only `<code>` today); Remove stays.
- **Adding a row:**
  - Name input and value input, with a visible **Add** button. Enter in either input also adds the row.
  - Choosing or typing a name fills the value with `${NAME}` until the user edits the value.
  - A name given as `${X}` is trimmed to `X`.
  - Lowercase names keep the inline warning.
  - Fix the datalist mismatch (input `list` = datalist `id`).
- **Helper text** under "Environment variables":
  > PATH, HOME and USER are always set. Add a row with the same name to override one. Use `${VAR}` to read a value from the API's environment, or type a literal. Literals are saved to config.yaml as plain text.
- **Errors:** `patchToolSetting` (`ui/src/services/tool-settings-api.ts`) throws an error that carries `fieldErrors`. The drawer shows each message under its row (`aria-invalid`, destructive text), and the save banner shows the summary. Editing a row clears that row's error.
- **Saving:** always send `env` for shell_exec, and `{}` when the list is empty. The empty-list workaround is removed, because `GET` now shows what's in the file.

---

## Testing

**API — `api/src/routes/v1/tool-settings.handlers.test.ts`** `[unit]`

- `GET` returns raw `${GH_TOKEN}` from config.yaml even when `GH_TOKEN` is set in `process.env`. This is the regression test for the leak.
- `PATCH` accepts a lookup, a literal (`/opt/bin:/usr/bin`) and a mix (`${HOME}/bin`).
- `PATCH` rejects a reference to an unset variable. The message names the row and doesn't contain the value.
- `PATCH` rejects a lowercase name.
- `PATCH` returns every invalid row in `fieldErrors`.
- `GET` → unchanged `PATCH` round-trip succeeds. This is #220's repro.
- `PATCH` with `env: {}` clears the stored entries.

**shell-executor — `lib/shell-executor/test/unit`** `[unit]`

- With no `env`, a spawned command sees the default `PATH/HOME/USER`.
- With only `GH_TOKEN`, it sees `GH_TOKEN` and the default `PATH`.
- A user `PATH` overrides the default.
- `ShellExecutorConfigSchema.partial().strict()` parse output contains no default env keys.

**UI — `ui/test/tool-settings-drawer.test.tsx`** `[unit]`

- Existing env values show in editable inputs, and edits are saved.
- Add button: `${NAME}` is filled in, and `${X}` pasted as a name is trimmed.
- `fieldErrors` show under the matching rows.
- Removing the last row saves `env: {}`.

**E2E — `e2e/tests/tool-settings-admin.spec.ts`** `@user-workflow`, CI-safe (no `@llm`)

- Change only the Shell Exec allowlist and save: success toast (#220 repro).
- Add `GH_TOKEN` (the E2E env sets it), save, reopen: the row shows `${GH_TOKEN}`, not the filled-in value.
- Add a row that references an unset variable: the error shows on that row.
- Clean up with Reset Defaults.

No eval scenario: nothing here changes LLM-facing behavior.

---

## Out of scope

- Other settings endpoints that may return filled-in values (model provider keys, etc.). Worth auditing separately.
- Heuristics that detect secrets pasted as literals (rejected in Decisions).
