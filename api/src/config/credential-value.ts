// Shared "literal value or ${ENV_VAR} reference" concept, used by every
// single-scalar secret field in this app (the git-credentials token, the
// tracker github token) and by tool-settings.handlers.ts's shell_exec env
// map validation. config-manager's own interpolateEnvVars() only matches
// /\$\{([A-Z_][A-Z0-9_]*)\}/g — lowercase names stay literal strings — so
// every regex here mirrors that shape.
export const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// Whole-string anchored: a single-purpose secret field is either a literal
// or a reference, never a mix (unlike shell_exec's per-value scan, which
// allows "${HOME}/bin"-style mixed values and stays local to
// tool-settings.handlers.ts). Returns the captured name, or null when the
// value isn't a pure reference (including a badly-shaped one, which is then
// just treated as a literal).
const WHOLE_ENV_REF_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

export function isEnvRef(value: string): string | null {
  return WHOLE_ENV_REF_RE.exec(value)?.[1] ?? null;
}

// null = valid. Shape check first, then existence — a missing variable
// would silently resolve to an empty string at load, so it's caught here
// instead. The message text is relied on verbatim by
// tool-settings.handlers.ts's existing tests (issues #189, #220) — keep it
// unchanged if this function is ever edited.
export function validateEnvRefName(name: string): string | null {
  if (!ENV_VAR_NAME_RE.test(name)) {
    return `"${name}" is not a valid environment variable name (uppercase letters, digits or _ only).`;
  }
  if (!(name in process.env)) {
    return (
      `references \${${name}}, which isn't set in the API's environment. ` +
      'Set it and restart the API, or remove the reference.'
    );
  }
  return null;
}

export type CredentialDisplay =
  { mode: 'unset' } | { mode: 'literal' } | { mode: 'env'; name: string };

// Safe to compute from a raw (unresolved) config.yaml value — the 'env'
// case's name is never the secret itself, only literal mode's value is
// sensitive, and this never returns it.
export function describeCredential(raw: string | undefined): CredentialDisplay {
  if (raw === undefined || raw === '') return { mode: 'unset' };
  const name = isEnvRef(raw);
  if (name) return { mode: 'env', name };
  return { mode: 'literal' };
}

// For writing a single-scalar credential field: null = valid (unset,
// literal, or a reference to a variable that exists); otherwise the error
// to report against that field.
export function validateCredentialValue(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  const name = isEnvRef(raw);
  if (!name) return null;
  return validateEnvRefName(name);
}
