import { z } from 'zod';
import { testMcpConnection } from '@tkottke90/tools-manager';
import type {
  ToolsManager,
  McpServerConfig,
  McpStdioConfig,
  McpHttpConfig,
} from '@tkottke90/tools-manager';
import { MASK } from './settings.handlers.js';

// ---- HandlerResult (mirrors workspaces.handlers.ts) ---------------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404 | 409 | 502;
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

function conflict(error: string): HandlerFailure {
  return { ok: false, status: 409, error };
}

function badGateway(error: string): HandlerFailure {
  return { ok: false, status: 502, error };
}

// ---- Validation ----------------------------------------------------------------

const RestartSchema = z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().optional(),
  delayMs: z.number().optional(),
});

const McpStdioConfigSchema = z.object({
  transport: z.literal('stdio').optional(),
  enabled: z.boolean().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  restart: RestartSchema.optional(),
});

const McpHttpConfigSchema = z.object({
  transport: z.enum(['http', 'sse']),
  enabled: z.boolean().optional(),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  reconnect: RestartSchema.optional(),
});

// Full-config validation for POST / — a proper discriminated union.
const McpServerConfigSchema = z.union([McpStdioConfigSchema, McpHttpConfigSchema]);

// PATCH / test bodies are a partial merge over whatever's already stored
// (ToolsManager.editMcpServer does an untyped shallow merge regardless of
// transport), so this is a single permissive object rather than a
// discriminated union `.partial()` (which zod can't express cleanly).
const McpServerPatchSchema = z.object({
  transport: z.enum(['stdio', 'http', 'sse']).optional(),
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  restart: RestartSchema.optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  reconnect: RestartSchema.optional(),
});

type McpServerPatch = z.infer<typeof McpServerPatchSchema>;

const CreateMcpServerSchema = z.object({
  name: z.string().min(1),
  config: McpServerConfigSchema,
});

// ---- Secret masking --------------------------------------------------------------
//
// env (stdio) / headers (http, sse) values are masked/unmasked the same way
// the apiKey field is (MASK/maskApiKey/unmaskApiKey in settings.handlers.ts),
// but per-record-entry rather than per-field: an empty string value is a
// real, intentional value here (e.g. DEBUG=""), not "absent", so it's left
// as-is rather than treated like maskApiKey treats an empty apiKey.

function maskValue(value: string): string {
  return value === '' ? '' : MASK;
}

function unmaskValue(incoming: string, stored: string | undefined): string {
  return incoming === MASK ? (stored ?? incoming) : incoming;
}

function mapSecretRecord(
  record: Record<string, string> | undefined,
  transform: (key: string, value: string) => string,
): Record<string, string> | undefined {
  if (!record) return record;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, transform(k, v)]));
}

function maskConfigSecrets(config: McpServerConfig): McpServerConfig {
  const c = config as McpStdioConfig & McpHttpConfig;
  return {
    ...config,
    ...(c.env !== undefined ? { env: mapSecretRecord(c.env, (_k, v) => maskValue(v)) } : {}),
    ...(c.headers !== undefined
      ? { headers: mapSecretRecord(c.headers, (_k, v) => maskValue(v)) }
      : {}),
  } as McpServerConfig;
}

function unmaskConfigSecrets(draft: McpServerPatch, stored: McpServerConfig): McpServerPatch {
  const s = stored as McpStdioConfig & McpHttpConfig;
  const result: McpServerPatch = { ...draft };
  if (draft.env !== undefined) {
    result.env = mapSecretRecord(draft.env, (k, v) => unmaskValue(v, s.env?.[k]));
  }
  if (draft.headers !== undefined) {
    result.headers = mapSecretRecord(draft.headers, (k, v) => unmaskValue(v, s.headers?.[k]));
  }
  return result;
}

// ---- Handlers --------------------------------------------------------------------

export interface McpServerListItem {
  name: string;
  config: McpServerConfig;
}

export function listMcpServersHandler(manager: ToolsManager): HandlerResult<McpServerListItem[]> {
  const servers = manager.listMcpServers();
  const data = Object.entries(servers).map(([name, config]) => ({
    name,
    config: maskConfigSecrets(config),
  }));
  return ok(data);
}

export async function createMcpServerHandler(
  manager: ToolsManager,
  body: unknown,
): Promise<HandlerResult<McpServerListItem>> {
  const parsed = CreateMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { name, config } = parsed.data;
  if (name in manager.listMcpServers()) {
    return conflict(`MCP server "${name}" already exists`);
  }
  await manager.addMcpServer(name, config as McpServerConfig);
  return ok({ name, config: maskConfigSecrets(config as McpServerConfig) });
}

export async function patchMcpServerHandler(
  manager: ToolsManager,
  name: string,
  body: unknown,
): Promise<HandlerResult<McpServerListItem>> {
  const stored = manager.listMcpServers()[name];
  if (!stored) return notFound(`MCP server "${name}" not found`);

  const parsed = McpServerPatchSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const unmasked = unmaskConfigSecrets(parsed.data, stored);
  await manager.editMcpServer(name, unmasked as Partial<McpServerConfig>);
  const updated = manager.listMcpServers()[name]!;
  return ok({ name, config: maskConfigSecrets(updated) });
}

export async function deleteMcpServerHandler(
  manager: ToolsManager,
  name: string,
): Promise<HandlerResult<{ deleted: true }>> {
  if (!(name in manager.listMcpServers())) {
    return notFound(`MCP server "${name}" not found`);
  }
  await manager.removeMcpServer(name);
  return ok({ deleted: true });
}

export interface TestConnectionData {
  toolCount: number;
  toolNames: string[];
}

// testFn is injectable (defaulting to the real testMcpConnection) purely so
// tests can exercise the 200/502 branching without spawning a real MCP
// server or opening a real network connection.
export async function testNewMcpServerHandler(
  body: unknown,
  testFn: (c: McpServerConfig) => Promise<TestConnectionData> = testMcpConnection,
): Promise<HandlerResult<TestConnectionData>> {
  const parsed = McpServerConfigSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  try {
    const result = await testFn(parsed.data as McpServerConfig);
    return ok(result);
  } catch (err) {
    return badGateway(err instanceof Error ? err.message : String(err));
  }
}

export async function testExistingMcpServerHandler(
  manager: ToolsManager,
  name: string,
  body: unknown,
  testFn: (c: McpServerConfig) => Promise<TestConnectionData> = testMcpConnection,
): Promise<HandlerResult<TestConnectionData>> {
  const stored = manager.listMcpServers()[name];
  if (!stored) return notFound(`MCP server "${name}" not found`);

  const parsed = McpServerPatchSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const unmasked = unmaskConfigSecrets(parsed.data, stored) as McpServerConfig;
  try {
    const result = await testFn(unmasked);
    return ok(result);
  } catch (err) {
    return badGateway(err instanceof Error ? err.message : String(err));
  }
}
