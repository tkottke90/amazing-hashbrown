# Git Credentials for Workspace Git Operations — Design

**Date:** 2026-10-05
**Status:** Draft
**Related:** [Issue #181](https://github.com/tkottke90/amazing-hashbrown/issues/181) (Git Push Authentication Error in Workspaces Files Viewer)

---

## Goal

Fix the actual reported bug — the Workspaces Files viewer's Push button fails
with `fatal: could not read Username for 'https://github.com'` — and, in
doing so, close the credential gap for every git network operation that
shares the same root cause, not just push. Along the way, unify how this
application stores a secret value that may either be a literal, or a
reference to a host environment variable, across the three places that
already need (or are about to need) that choice:

1. A new, dedicated GitHub PAT for workspace/project git operations (clone,
   fetch, sync, push).
2. The existing GitHub PAT used for issue-tracker API calls
   (`workspaces.tasks.trackers.github.token`).
3. `shell_exec`'s per-key `env` map, which already supports `${VAR}` syntax
   today but only via hand-typed text.

---

## Problem

`provisionGitRepository()` (`api/src/services/workspace-provision.ts`) runs
`git clone -- <remoteUrl> .` with no credentials. `fetchRemote()`,
`syncFastForward()`, and `pushBranch()` (`api/src/services/workspace-git.ts`)
run plain `git fetch` / `git push` the same way. None of these shell-outs
carry any authentication, and the container has no interactive TTY for git
to prompt on, and no git credential helper configured. Any workspace or
project cloned from a private GitHub repo over HTTPS is broken end-to-end —
clone fails outright, and if clone is skipped (an already-provisioned
directory), fetch/sync/push fail with the exact error in the issue.

This is not specifically a "Push button" bug. It is a missing credential
story for every git network operation this application performs.

Separately, this application already has a working pattern for "a config
value that's either a literal secret or a reference to a host env var" —
`shell_exec`'s `env` map, validated in
`api/src/routes/v1/tool-settings.handlers.ts`'s `validateShellEnv()` — but
it's hand-typed (`${GH_TOKEN}`), and the tracker GitHub token
(`api/src/routes/v1/settings.handlers.ts`'s `trackers` slug) has no such
capability at all — it only ever stores a literal, masked secret. Three
surfaces, one underlying concept, no shared implementation.

---

## Scope

**In scope:**

- A new `workspaces.git.github.token` config field, used only to
  authenticate workspace/project git network operations.
- Wiring that token into `provisionGitRepository`'s clone, and into
  `fetchRemote`/`syncFastForward`/`pushBranch`.
- A shared "literal or env-var reference" credential-value concept, backend
  and frontend, used by the new git token field, the existing tracker token
  field (retrofit), and shell_exec's env-row editor (retrofit).
- A new Settings UI subsection ("Git") in the Workspaces panel.
- Clearer error messages when a git network operation still fails auth.

**Out of scope:**

- SSH-based authentication (the issue's "suggested solutions" mention it,
  but the reported failure and the fix here are both HTTPS/PAT-based; an
  SSH remote already works today via the host's own `ssh-agent`, untouched
  by this change).
- Non-GitHub git hosts. The credential is explicitly a GitHub PAT, matching
  the existing tracker adapter's scope (GitHub is the only registered
  tracker type today).
- Any change to how literal (non-env-ref) `shell_exec` values are displayed
  — they are unmasked today and stay that way; only the *input* UX for
  choosing literal-vs-env-var gains the shared component.

---

## Design

### 1. New config: `workspaces.git.github.token`

Extends `WorkspacesSchema` (`api/src/config/env.ts`) with a sibling to the
existing `tasks.trackers` section:

```ts
export const GitCredentialsSchema = z.object({
  github: z.object({ token: z.string().optional() }).optional(),
});

export const WorkspacesSchema = z.object({
  git: GitCredentialsSchema.optional(),
  tasks: TasksConfigSchema.optional(), // existing
});
```

`token` is a plain string on disk — either a literal PAT, or a
config-manager lookup (`${GH_TOKEN}`), resolved automatically at load time by
the existing `@tkottke90/config-manager` interpolation. No schema change is
needed to support both shapes; only the settings handler's read/write path
(§2) needs to treat the two shapes differently.

This is deliberately a separate field from `trackers.github.token`, not a
shared one — a user who wants one PAT for both can point both fields at the
same env var (e.g. both set to `${GH_TOKEN}`); a user who wants separate
scoping (e.g. a fine-grained token for git ops, a classic token for issue
creation) can store two different literals. Neither settings section reads
the other's value.

### 2. Shared credential-value concept

Per this repo's composition-over-customization principle, this is one small
reusable **behavior**, not a new generic config bag — every consumer keeps
its own typed field (`workspaces.git.github.token`,
`workspaces.tasks.trackers.github.token`, `tools.shell_exec.env.<KEY>`); only
the "is this a literal or an env-var reference, and is that reference valid"
logic and its matching UI affordance are shared.

**Backend** — new `api/src/config/credential-value.ts`:

```ts
// Matches config-manager's own interpolation syntax
// (/\$\{([A-Z_][A-Z0-9_]*)\}/g), but anchored to the whole string: a
// single-purpose secret field is either a reference or a literal, never a
// mix (unlike shell_exec's PATH-style "${HOME}/bin" values).
export function isEnvRef(value: string): string | null;

// Reuses the same "must exist in process.env" check already in
// tool-settings.handlers.ts's validateShellEnv() — moved here so both call
// one implementation instead of two copies of the same regex and error
// message.
export function validateEnvRefName(name: string): string | null; // null = valid, else an error message
```

`tool-settings.handlers.ts`'s `validateShellEnv()` is refactored to call
`validateEnvRefName()` per matched reference inside a value, instead of
inlining the check — its own behavior (mixed literal+ref values, per-key
validation) is unchanged.

**Settings handlers** — both the new `git-credentials` slug and the existing
`trackers` slug (`api/src/routes/v1/settings.handlers.ts`) must read the
**raw**, unresolved `config.yaml` value for their token field, the same way
`readRawToolsConfig()` already does for `tools.*` (issue #220's lesson:
building a settings response from resolved `env.*` either leaks a resolved
secret or loses the `${VAR}` syntax entirely). `get()` returns one of:

```ts
type CredentialDisplay =
  | { mode: 'unset' }
  | { mode: 'literal' } // never includes the value — existing MASK sentinel on write
  | { mode: 'env'; name: string }; // safe to show as-is, it's not the secret
```

`write()` validates via `validateEnvRefName()` when the incoming value is an
env-ref shape, otherwise applies the existing `unmaskApiKey()` literal
handling unchanged (submitting the `****` sentinel keeps whatever raw string
is already stored, env-ref or literal — no special-casing needed there,
since `unmaskApiKey` already just returns the stored raw string verbatim).

**Frontend** — new `ui/src/components/credential-value-field.tsx`:

A toggle between:
- **Literal value** — masked password input (prefilled with the `****`
  sentinel when a secret is already stored), the default mode.
- **From environment variable** — a plain-text name input (prefilled with a
  suggested name, e.g. `GH_TOKEN`, editable), composing `${NAME}` on save.
  Helper text makes explicit that this means "the API process must have this
  environment variable set."

Used by:

1. The new Git Credentials settings section (§4).
2. `TrackerConfigModal`'s token field (`ui/src/pages/settings/tracker-config-modal.tsx`) — retrofit, replacing its current plain masked `Input`.
3. Each shell_exec env row's *value* input in `tool-settings-drawer.tsx` — retrofit. The row's *key* name (e.g. `GH_TOKEN`, `PATH`) stays a freeform text input, since not every key is a secret and the key name is independent of where its value comes from. A user who needs a mixed literal like `${HOME}/bin` still picks "Literal value" and types it directly — the backend's existing `ENV_REF_RE` scan inside `validateShellEnv()` doesn't care which UI mode produced the string, so this is a pure UX improvement with no behavior regression.

### 3. Actually fixing git auth

New `api/src/services/git-credentials.ts`:

```ts
import { env } from '../config/env.js';

// http.<url-prefix>.extraHeader is git's own conditional-by-host config —
// setting it unconditionally is harmless for a non-GitHub remote (git only
// attaches the header to requests matching that URL prefix), so no
// remote-URL inspection is needed before computing this. Passed as a
// one-off `-c` flag on each invocation: never written to .git/config or the
// remote URL, so it never persists to disk and never shows in `git remote
// -v`. Same technique actions/checkout uses for the same reason.
export function buildGitAuthArgs(token = env.workspaces.git?.github?.token): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraHeader=Authorization: Basic ${basic}`];
}
```

Wired into every git network call site, each keeping its existing
injectable `execFileFn` parameter for tests:

- `provisionGitRepository`'s `git clone -- <remoteUrl> .`
- `fetchRemote`'s `git fetch`
- `syncFastForward`'s `git fetch` leg (the subsequent `merge --ff-only` is
  local — no credential needed)
- `pushBranch`'s both branches (`git push` and the first-push
  `git push -u origin -- <branch>`)

The token argument defaults to the live resolved config value but accepts an
override, matching this codebase's existing test-injection convention.

### 4. Settings UI

New "Git" subsection in the Workspaces settings panel
(`ui/src/pages/settings/workspaces-panel.tsx`'s `SUBSECTIONS`), sibling to
the existing "Trackers" tab. New `GET/PATCH /api/v1/settings/git-credentials`
slug in `settings.handlers.ts`'s `SLUG_MAP`, built the same way the
`trackers` slug is today (mask/unmask plus the new `CredentialDisplay` shape
from §2). New `git-credentials-section.tsx` + a small API client function
alongside the existing `trackers-api.ts`.

### 5. Error clarity

Git's raw stderr on an auth failure (`fatal: could not read Username for
'https://github.com': No such device or address`) is surfaced verbatim today
(`workspace-git.handlers.ts`'s catch blocks pass `err.message` straight
through). Add `translateGitAuthError(message: string): string` (co-located
in `api/src/services/workspace-git.ts`), applied in the catch paths of
`fetchRemote`, `syncFastForward`, `pushBranch`, and
`provisionGitRepository`. It matches specifically on that git error string
and rewrites it to:

> "Git push/fetch/clone failed: no GitHub credentials are configured for
> workspace git operations. Add a token in Settings → Workspaces → Git."

(the verb substituted per which operation failed). Any other git error
(merge conflict, network failure, repo not found, token present but lacking
access) passes through unchanged — this only replaces the specific
"no credentials at all" case, which is the one piece of stock git output
that gives the user no actionable next step.

---

## Testing

Per the root `AGENTS.md` testing policy — unit tests unless noted:

- `credential-value.ts`: `isEnvRef`/`validateEnvRefName`, happy path + bad
  name shape + unset host var.
- `git-credentials.ts`: `buildGitAuthArgs` — returns `[]` with no token
  configured, returns the expected `-c` arg with one configured, token
  override param honored.
- `workspace-provision.ts`/`workspace-git.ts`: each updated call site passes
  the auth args through to `execFileFn` when a token is configured and omits
  them when not (stubbed `execFileFn`, asserting on the args array, same
  pattern as the existing tests in these files); `translateGitAuthError`
  covered directly plus through at least one call site's catch path.
- `settings.handlers.ts`: new `git-credentials` slug's get/patch (raw read,
  mask/unmask, env-ref display and validation) mirroring the existing
  `trackers` slug's test coverage; `trackers` slug's tests extended for its
  new env-ref capability.
- `tool-settings.handlers.ts`: existing `validateShellEnv` tests continue to
  pass unchanged against the refactored-to-shared `validateEnvRefName`
  (orchestration-level regression check, not new behavior).
- Frontend (Jest): `CredentialValueField` (toggle behavior, composes
  `${NAME}` correctly, prefill from each `CredentialDisplay` mode) and one
  test per call site (git-credentials section, tracker modal, shell_exec
  drawer row) confirming it's wired in and round-trips through its
  respective save path.
- No E2E changes required beyond whatever the existing Settings-page suite
  already exercises for a new subsection tab; git network behavior itself
  isn't E2E-testable without a real GitHub remote and is covered at the
  unit level above.
