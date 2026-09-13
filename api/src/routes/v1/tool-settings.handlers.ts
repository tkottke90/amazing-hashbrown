import { z } from 'zod';
import { ShellExecutorConfigSchema } from '@tkottke90/shell-executor';
import type { ToolsManager } from '@tkottke90/tools-manager';
import { getToolSettingsStore } from '../../services/tool-settings-store.js';
import { syncMcpToolStatus } from '../../agents/mcp-tool-status.js';
import {
  listResolvedToolSettings,
  type ResolvedToolSettingItem,
} from '../../agents/tool-config.js';
import { WebFetchConfigSchema, RLMConfigSchema, type ToolEntry } from '../../config/env.js';
import { readConfigYaml, mergeConfigYaml } from './settings.handlers.js';

// ---- HandlerResult (mirrors mcp-servers.handlers.ts) ----------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
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

// toolsConfig is an optional override purely for testability — production
// call sites (the route) omit it and get the real config.yaml-backed state.
export function listToolSettingsHandler(
  toolsConfig?: Record<string, ToolEntry>,
): HandlerResult<ToolSettingItem[]> {
  return ok(listResolvedToolSettings(toolsConfig));
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
    validatedExtra = parsedExtra.data as Record<string, unknown>;
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
): Promise<HandlerResult<ToolSettingItem[]>> {
  await manager.refreshMcpTools();
  syncMcpToolStatus(manager, getToolSettingsStore());
  return ok(listResolvedToolSettings());
}
