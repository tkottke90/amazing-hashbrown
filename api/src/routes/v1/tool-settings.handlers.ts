import { z } from 'zod';
import { ShellExecutorConfigSchema } from '@tkottke90/shell-executor';
import type { ToolsManager } from '@tkottke90/tools-manager';
import { getToolSettingsStore } from '../../services/tool-settings-store.js';
import { syncMcpToolStatus } from '../../agents/mcp-tool-status.js';
import {
  listResolvedToolSettings,
  type ResolvedToolSettingItem,
} from '../../agents/tool-config.js';
import {
  WebFetchConfigSchema,
  RLMConfigSchema,
  ToolsConfigSchema,
  type ToolEntry,
} from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { readConfigYaml, mergeConfigYaml } from './settings.handlers.js';

// ---- HandlerResult (mirrors mcp-servers.handlers.ts) ----------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404;
  error: string;
  // Same shape as skills.handlers.ts's fieldErrors. Env rows are keyed
  // "env.<NAME>" so the drawer can show each message next to its row (#220).
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

// ---- shell_exec env validation (issues #189, #220) --------------------------

// config-manager's interpolateEnvVars() only matches
// /\$\{([A-Z_][A-Z0-9_]*)\}/g — lowercase names stay literal strings.
export const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
// Every lookup inside a value. Values may be a lookup, a literal or a mix
// ("${HOME}/bin") — literals are stored in config.yaml as plain text, which
// the drawer's helper text states.
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

// Messages name the row and the fix, never the submitted value — a value may
// be a secret the user pasted as a literal.
function validateShellEnv(env: Record<string, unknown>): HandlerResult<Record<string, string>> {
  const validated: Record<string, string> = {};
  const fieldErrors: Record<string, string[]> = {};
  const fail = (key: string, message: string) =>
    (fieldErrors[`env.${key}`] ??= []).push(`${key}: ${message}`);

  for (const [key, rawValue] of Object.entries(env)) {
    if (!ENV_VAR_NAME_RE.test(key)) {
      fail(key, 'names must be uppercase letters, digits or _ (e.g. GH_TOKEN).');
      continue;
    }
    if (typeof rawValue !== 'string') {
      fail(key, 'value must be text.');
      continue;
    }
    // A missing variable would silently resolve to an empty string at load.
    const missing = [...rawValue.matchAll(ENV_REF_RE)]
      .map((m) => m[1]!)
      .filter((name) => !(name in process.env));
    for (const name of new Set(missing)) {
      fail(
        key,
        `references \${${name}}, which isn't set in the API's environment. ` +
          'Set it and restart the API, or remove the reference.',
      );
    }
    if (missing.length === 0) validated[key] = rawValue;
  }

  const rows = Object.keys(fieldErrors).length;
  if (rows > 0) {
    return badRequest(
      `${rows} environment variable${rows === 1 ? ' is' : 's are'} invalid.`,
      fieldErrors,
    );
  }
  return { ok: true, data: validated };
}

// Names only — values are never included, logged, or sent. Used by the
// drawer's env editor combobox to suggest names for new rows.
export function listAvailableEnvVarsHandler(): HandlerResult<{ names: string[] }> {
  const names = Object.keys(process.env)
    .filter((name) => ENV_VAR_NAME_RE.test(name))
    .sort((a, b) => a.localeCompare(b));
  return ok({ names });
}

// ---- Validation ------------------------------------------------------------

const DefaultIncludePatchSchema = z.object({
  chat: z.boolean().optional(),
  subAgent: z.boolean().optional(),
  autonomous: z.boolean().optional(),
});

// The generic fields every tool shares, plus a catchall for the handful of
// tool-specific extra fields (web_fetch/rlm_query/shell_exec) — validated
// against their own typed schema below, only when the toolId matches.
const PatchToolSettingSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultInclude: DefaultIncludePatchSchema.optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
  })
  .catchall(z.unknown());

// .strict() — a plain .partial() silently strips unrecognized keys instead
// of rejecting them, which would let an unsupported field through as a
// no-op rather than surfacing the 400 a typo or stale client deserves.
const EXTRA_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  web_fetch: WebFetchConfigSchema.partial().strict(),
  rlm_query: RLMConfigSchema.partial().strict(),
  shell_exec: ShellExecutorConfigSchema.partial().strict(),
};

const GENERIC_FIELD_NAMES = new Set(['enabled', 'defaultInclude', 'description', 'instructions']);

// ---- Handlers ----------------------------------------------------------------

export type ToolSettingItem = ResolvedToolSettingItem;

// The tools section exactly as written in config.yaml — ${VAR} lookups left
// unresolved. Anything the settings UI reads must come from here, not from
// env.tools: config-manager interpolates lookups at load time, so env.tools
// holds resolved secrets (issue #220). Runtime consumers keep env.tools.
export function readRawToolsConfig(configDir: string): Record<string, ToolEntry> {
  const parsed = ToolsConfigSchema.safeParse(readConfigYaml(configDir)['tools']);
  if (!parsed.success) {
    logger.warn('config.yaml tools section failed validation; showing defaults', {
      issues: parsed.error.issues.map((i) => i.message),
    });
    return {};
  }
  return parsed.data;
}

export function listToolSettingsHandler(configDir: string): HandlerResult<ToolSettingItem[]> {
  return ok(listResolvedToolSettings(readRawToolsConfig(configDir)));
}

function findResolved(
  toolId: string,
  toolsConfig?: Record<string, ToolEntry>,
): ToolSettingItem | undefined {
  return listResolvedToolSettings(toolsConfig).find((t) => t.toolId === toolId);
}

export function patchToolSettingHandler(
  toolId: string,
  body: unknown,
  configDir: string,
  // Called after a successful write so the real config-manager singleton
  // picks up the change for every subsequent read (the next chat turn's
  // toolAccessMiddleware call, the next GET) — production passes the real
  // configManager.reload; tests omit it (their own response is built from
  // the in-memory updatedTools map below, not a re-read of the singleton).
  reload: () => void = () => {},
): HandlerResult<ToolSettingItem> {
  const existing = findResolved(toolId);
  if (!existing) return notFound(`Tool "${toolId}" not found`);
  if (existing.category === 'skill-gated') {
    return badRequest(`Tool "${toolId}" is read-only (skill-gated)`);
  }

  const parsed = PatchToolSettingSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { enabled, defaultInclude, description, instructions, ...extra } = parsed.data;

  if (existing.alwaysOn && (enabled !== undefined || defaultInclude !== undefined)) {
    return badRequest(`Tool "${toolId}" is always on — enabled/defaultInclude cannot be changed`);
  }

  let validatedExtra: Record<string, unknown> = {};
  const extraKeys = Object.keys(extra).filter((k) => !GENERIC_FIELD_NAMES.has(k));
  if (extraKeys.length > 0) {
    const extraSchema = EXTRA_FIELD_SCHEMAS[toolId];
    if (!extraSchema) {
      return badRequest(`Tool "${toolId}" does not support field(s): ${extraKeys.join(', ')}`);
    }
    const parsedExtra = extraSchema.safeParse(extra);
    if (!parsedExtra.success) {
      return badRequest(parsedExtra.error.issues.map((i) => i.message).join('; '));
    }
    // Zod 4's .partial() still fills in field defaults, so keep only the
    // keys the client actually sent — otherwise saving one field writes every
    // other field's default into config.yaml (for shell_exec that included
    // the host's literal PATH/HOME/USER, the origin of issue #220).
    const parsedData = parsedExtra.data as Record<string, unknown>;
    validatedExtra = Object.fromEntries(extraKeys.map((k) => [k, parsedData[k]]));
    // shell_exec-specific: env entries must be config-manager lookup syntax
    // referencing variables that actually exist (issue #189).
    if (toolId === 'shell_exec' && validatedExtra['env'] !== undefined) {
      const envResult = validateShellEnv(validatedExtra['env'] as Record<string, unknown>);
      if (!envResult.ok) return envResult;
      validatedExtra['env'] = envResult.data;
    }
  }

  const currentTools = (readConfigYaml(configDir)['tools'] as Record<string, ToolEntry>) ?? {};
  const currentEntry = currentTools[toolId] ?? {};
  const mergedEntry: Record<string, unknown> = { ...currentEntry, ...validatedExtra };
  if (enabled !== undefined) mergedEntry['enabled'] = enabled;
  if (defaultInclude !== undefined) {
    mergedEntry['defaultInclude'] = { ...currentEntry.defaultInclude, ...defaultInclude };
  }
  if (description !== undefined) mergedEntry['description'] = description;
  if (instructions !== undefined) mergedEntry['instructions'] = instructions;

  const updatedTools = { ...currentTools, [toolId]: mergedEntry };
  mergeConfigYaml(configDir, { tools: updatedTools });
  reload();

  return ok(findResolved(toolId, updatedTools)!);
}

export function deleteToolSettingHandler(
  toolId: string,
  configDir: string,
  reload: () => void = () => {},
): HandlerResult<ToolSettingItem> {
  const existing = findResolved(toolId);
  if (!existing) return notFound(`Tool "${toolId}" not found`);

  const currentTools = {
    ...((readConfigYaml(configDir)['tools'] as Record<string, ToolEntry>) ?? {}),
  };
  delete currentTools[toolId];
  mergeConfigYaml(configDir, { tools: currentTools });
  reload();

  return ok(findResolved(toolId, currentTools)!);
}

export async function refreshToolSettingsHandler(
  manager: ToolsManager,
  configDir: string,
): Promise<HandlerResult<ToolSettingItem[]>> {
  await manager.refreshMcpTools();
  syncMcpToolStatus(manager, getToolSettingsStore());
  return ok(listResolvedToolSettings(readRawToolsConfig(configDir)));
}
