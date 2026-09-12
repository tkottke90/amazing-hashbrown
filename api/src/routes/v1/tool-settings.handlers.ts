import { z } from 'zod';
import type { ToolsManager } from '@tkottke90/tools-manager';
import type { ToolSettingsStore, ToolSettingRow } from '../../services/tool-settings-store.js';
import { syncMcpToolStatus } from '../../agents/mcp-tool-status.js';

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

const PatchToolSettingSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultInclude: z.boolean().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.defaultInclude !== undefined, {
    message: 'at least one of enabled or defaultInclude is required',
  });

// ---- Handlers ----------------------------------------------------------------

export type ToolSettingItem = ToolSettingRow;

export function listToolSettingsHandler(
  store: ToolSettingsStore,
): HandlerResult<ToolSettingItem[]> {
  return ok(store.list());
}

export function patchToolSettingHandler(
  store: ToolSettingsStore,
  toolId: string,
  body: unknown,
): HandlerResult<ToolSettingItem> {
  const parsed = PatchToolSettingSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const result = store.patch(toolId, parsed.data);
  if (result === 'not-found') return notFound(`Tool "${toolId}" not found`);
  if (result === 'not-patchable') {
    return badRequest(`Tool "${toolId}" cannot be changed globally (wiki or skill-gated)`);
  }
  return ok(result);
}

export async function refreshToolSettingsHandler(
  manager: ToolsManager,
  store: ToolSettingsStore,
): Promise<HandlerResult<ToolSettingItem[]>> {
  await manager.refreshMcpTools();
  syncMcpToolStatus(manager, store);
  return ok(store.list());
}
