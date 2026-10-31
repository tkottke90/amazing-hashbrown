import { z } from 'zod';
import { slugifyServerName } from '@tkottke90/tools-manager';
import { env, type RoleConfig } from '../../config/env.js';
import { readConfigYaml, mergeConfigYaml } from './settings.handlers.js';

// ---- HandlerResult (mirrors tool-settings.handlers.ts) --------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404;
  error: string;
  // Keyed per-field (e.g. "provider", "name") so a drawer can show each
  // message next to its row — same shape tool-settings.handlers.ts uses.
  fieldErrors?: Record<string, string[]>;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string, fieldErrors?: Record<string, string[]>): HandlerFailure {
  return fieldErrors
    ? { ok: false, status: 400, error, fieldErrors }
    : { ok: false, status: 400, error };
}

// ---- Validation -------------------------------------------------------------

// A Role name is a slug — lowercase, hyphen-separated — same convention as
// an MCP Server's own name (GLOSSARY.md § Sub-Agent Roles). Reused as a
// validator by equality: a name is a valid slug iff it's already its own
// canonical slugified form.
export function isValidRoleName(name: string): boolean {
  return name.length > 0 && slugifyServerName(name) === name;
}

const ROLE_NAME_MESSAGE =
  'Role name must be lowercase letters, digits and hyphens (e.g. "code-reviewer").';

const roleNameSchema = z.string().min(1).refine(isValidRoleName, { message: ROLE_NAME_MESSAGE });

// A field may be omitted (leave unchanged / not set), an explicit `null`
// (clear it — e.g. "reset provider/model back to the system default"), or a
// string (set it). zod distinguishes "key absent" from "key present as
// null" in parsed output, which is exactly the 3-way signal patchRoleHandler
// needs; createRoleHandler only cares about string-vs-not-set, so it
// normalizes null to undefined.
const RoleFieldsSchema = z.object({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
});

const CreateRoleSchema = RoleFieldsSchema.extend({ name: roleNameSchema });
const PatchRoleSchema = RoleFieldsSchema.partial().extend({ name: roleNameSchema.optional() });
const SetDefaultRoleSchema = z.object({ name: z.string().min(1) });

type RoleFieldsInput = z.infer<typeof RoleFieldsSchema>;

function normalizeCreateFields(fields: RoleFieldsInput): RoleConfig {
  return {
    provider: fields.provider ?? undefined,
    model: fields.model ?? undefined,
    systemPrompt: fields.systemPrompt ?? undefined,
  };
}

// Applies an omitted/null/string patch field over an existing Role's value:
// omitted (key absent) leaves it unchanged, null clears it, a string sets it.
function mergeRoleFields(existing: RoleConfig, patch: RoleFieldsInput): RoleConfig {
  const next: RoleConfig = { ...existing };
  for (const key of ['provider', 'model', 'systemPrompt'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

// ---- Shared read/write of the agent.roles / agent.defaultRole subtree ----

// mergeConfigYaml() is a shallow merge at the top-level `agent` YAML key —
// roles/defaultRole share that key with recursionLimit/subAgentRecursionLimit/
// loopGuard, so every write here must spread the rest of the raw `agent`
// section first (same gotcha trackers/git-credentials solve for the shared
// `workspaces` key in settings.handlers.ts). Read raw off disk rather than
// through the resolved `env.agent` getter, which swallows a parse failure to
// bare defaults and would silently drop whatever's actually on disk.
function readRawAgentSection(configDir: string): {
  roles: Record<string, RoleConfig>;
  defaultRole?: string;
} {
  const raw = (readConfigYaml(configDir)['agent'] as Record<string, unknown>) ?? {};
  return {
    roles: (raw['roles'] as Record<string, RoleConfig>) ?? {},
    defaultRole: raw['defaultRole'] as string | undefined,
  };
}

function writeAgentSection(
  configDir: string,
  next: { roles: Record<string, RoleConfig>; defaultRole: string | undefined },
): void {
  const raw = (readConfigYaml(configDir)['agent'] as Record<string, unknown>) ?? {};
  mergeConfigYaml(configDir, {
    agent: { ...raw, roles: next.roles, defaultRole: next.defaultRole },
  });
}

function providerFieldError(provider: string | null | undefined): string | undefined {
  if (provider === undefined || provider === null) return undefined;
  const known = new Set(env.providers.map((p) => p.name));
  return known.has(provider) ? undefined : `Provider "${provider}" is not configured.`;
}

// ---- Handlers ---------------------------------------------------------------

export interface RoleListItem extends RoleConfig {
  name: string;
}

export interface RolesListData {
  roles: RoleListItem[];
  defaultRole: string | null;
}

export function listRolesHandler(configDir: string): HandlerResult<RolesListData> {
  const { roles, defaultRole } = readRawAgentSection(configDir);
  return ok({
    roles: Object.entries(roles).map(([name, config]) => ({ name, ...config })),
    defaultRole: defaultRole ?? null,
  });
}

export function createRoleHandler(
  body: unknown,
  configDir: string,
  reload: () => void = () => {},
): HandlerResult<RoleListItem> {
  const parsed = CreateRoleSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { name, ...fields } = parsed.data;

  const { roles, defaultRole } = readRawAgentSection(configDir);
  if (roles[name]) {
    return badRequest(`Role "${name}" already exists.`, {
      name: [`Role "${name}" already exists.`],
    });
  }
  const providerError = providerFieldError(fields.provider);
  if (providerError) {
    return badRequest(providerError, { provider: [providerError] });
  }

  const roleConfig = normalizeCreateFields(fields);
  const updatedRoles = { ...roles, [name]: roleConfig };
  writeAgentSection(configDir, { roles: updatedRoles, defaultRole });
  reload();
  return ok({ name, ...roleConfig });
}

export function patchRoleHandler(
  name: string,
  body: unknown,
  configDir: string,
  reload: () => void = () => {},
): HandlerResult<RoleListItem> {
  const { roles, defaultRole } = readRawAgentSection(configDir);
  const existing = roles[name];
  if (!existing) return notFound(`Role "${name}" not found.`);

  const parsed = PatchRoleSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { name: newName, ...fields } = parsed.data;
  const providerError = providerFieldError(fields.provider);
  if (providerError) {
    return badRequest(providerError, { provider: [providerError] });
  }

  const merged = mergeRoleFields(existing, fields);
  const updatedRoles = { ...roles };
  let updatedDefaultRole = defaultRole;

  if (newName && newName !== name) {
    if (updatedRoles[newName]) {
      return badRequest(`Role "${newName}" already exists.`, {
        name: [`Role "${newName}" already exists.`],
      });
    }
    delete updatedRoles[name];
    updatedRoles[newName] = merged;
    if (defaultRole === name) updatedDefaultRole = newName;
  } else {
    updatedRoles[name] = merged;
  }

  writeAgentSection(configDir, { roles: updatedRoles, defaultRole: updatedDefaultRole });
  reload();
  return ok({ name: newName && newName !== name ? newName : name, ...merged });
}

export function deleteRoleHandler(
  name: string,
  configDir: string,
  reload: () => void = () => {},
): HandlerResult<{ deleted: true }> {
  const { roles, defaultRole } = readRawAgentSection(configDir);
  if (!roles[name]) return notFound(`Role "${name}" not found.`);

  if (Object.keys(roles).length <= 1) {
    return badRequest('Cannot delete the last remaining Role — at least one must always exist.');
  }

  const updatedRoles = { ...roles };
  delete updatedRoles[name];
  const updatedDefaultRole = defaultRole === name ? undefined : defaultRole;

  writeAgentSection(configDir, { roles: updatedRoles, defaultRole: updatedDefaultRole });
  reload();
  return ok({ deleted: true });
}

export function setDefaultRoleHandler(
  body: unknown,
  configDir: string,
  reload: () => void = () => {},
): HandlerResult<{ defaultRole: string }> {
  const parsed = SetDefaultRoleSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { name } = parsed.data;
  const { roles } = readRawAgentSection(configDir);
  if (!roles[name]) return notFound(`Role "${name}" not found.`);

  writeAgentSection(configDir, { roles, defaultRole: name });
  reload();
  return ok({ defaultRole: name });
}

// Boot-time invariant (ADR-0050/ADR-0051): the system never allows zero
// Roles to exist. Called once at server boot (src/index.ts) — if config.yaml
// has no Roles at all (a fresh install, or a hand-edited file that dropped
// to zero between restarts), create exactly one named "default" with no
// provider/model override (inherits the system default, ADR-0049) and set
// it as the Default Role immediately, so spawn_sub_agent's fallback always
// has somewhere to go.
export function ensureDefaultRole(configDir: string, reload: () => void = () => {}): void {
  const { roles } = readRawAgentSection(configDir);
  if (Object.keys(roles).length > 0) return;
  writeAgentSection(configDir, { roles: { default: {} }, defaultRole: 'default' });
  reload();
}
