import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import yaml from 'yaml';
import { z } from 'zod';
import {
  DatabaseSchema,
  ObservabilitySchema,
  AfterAgentSchema,
  ChatSchema,
  EmbeddingsSchema,
  RLMConfigSchema,
  WebFetchConfigSchema,
  ToolsConfigSchema,
  ProviderSchema,
  CostEntrySchema,
  type ProviderConfig,
  type CostEntry,
  type RLMConfig,
} from '../../config/env.js';

// ---- HandlerResult (mirrors artifacts.handlers.ts) ----------------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404 | 500;
  error: string;
  fieldErrors?: Record<string, string[]>;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function invalid(error: string, fieldErrors?: Record<string, string[]>): HandlerFailure {
  return { ok: false, status: 400, error, fieldErrors };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

// ---- Injected dependency types -----------------------------------------------

export interface ConfigManagerAccessor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(key: string, defaultValue?: any): unknown;
  getNumber(key: string, defaultValue: number): number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSection(key: string, schema: any): unknown;
  getConfigDir(path?: string): string;
  reload(): void;
}

export interface EnvAccessor {
  port: number;
  logLevel: string;
  providers: ProviderConfig[];
  defaultProvider: string;
  database: { path: string };
  observability: z.infer<typeof ObservabilitySchema>;
  afterAgent: z.infer<typeof AfterAgentSchema>;
  chat: z.infer<typeof ChatSchema>;
  embeddings: z.infer<typeof EmbeddingsSchema>;
  webFetch: z.infer<typeof WebFetchConfigSchema>;
  rlm: RLMConfig;
  costs: Record<string, CostEntry>;
  tools: Record<string, unknown> | undefined;
}

// ---- API key masking ----------------------------------------------------------

export const MASK = '****';

export function maskApiKey(key: string | undefined): string | undefined {
  if (key === undefined || key === '') return undefined;
  return MASK;
}

export function unmaskApiKey(
  incoming: string | undefined,
  stored: string | undefined,
): string | undefined {
  if (incoming === MASK) return stored;
  return incoming;
}

// ---- YAML config write -------------------------------------------------------

function readConfigYaml(configDir: string): Record<string, unknown> {
  const configPath = nodePath.join(configDir, 'config.yaml');
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf8');
  return (yaml.parse(raw) as Record<string, unknown>) ?? {};
}

function mergeConfigYaml(configDir: string, updates: Record<string, unknown>): void {
  const configPath = nodePath.join(configDir, 'config.yaml');
  const current = readConfigYaml(configDir);
  const merged = { ...current, ...updates };
  fs.writeFileSync(configPath, yaml.stringify(merged), 'utf8');
}

// ---- Section shapes -------------------------------------------------------------
// Canonical GET response / full-object PATCH body per settings slug — mirrors each
// SLUG_MAP entry's `get()` return shape below. External consumers (e.g. e2e tests
// asserting on the outgoing PATCH request body) should import these `import type`
// rather than redeclaring the shape by hand, so a schema change here surfaces as a
// compile error at the call site instead of a silently-stale test.

export type GeneralSettings = { port: number; logLevel: string };

export type StorageSettings = {
  wikiRoot: string;
  mcpConfigDir: string;
  artifactRoot: string;
  skillsRoot: string;
  database: { path: string };
};

export type ModelProvidersSettings = {
  providers: ProviderConfig[];
  defaultProvider: string;
};

export type EmbeddingsSettings = z.infer<typeof EmbeddingsSchema>;

export type AgentBehaviorSettings = {
  afterAgent: z.infer<typeof AfterAgentSchema>;
  chat: z.infer<typeof ChatSchema>;
  observability: z.infer<typeof ObservabilitySchema>;
};

export type ToolsSettings = {
  webFetch: z.infer<typeof WebFetchConfigSchema>;
  rlm: RLMConfig;
  tools?: z.infer<typeof ToolsConfigSchema>;
};

export type CostRatesSettings = { costs: Record<string, CostEntry> };

// ---- Slug definitions ---------------------------------------------------------

type GetFn = (env: EnvAccessor, config: ConfigManagerAccessor) => unknown;
type WriteFn = (validated: unknown, configDir: string, env: EnvAccessor) => void;

type SlugDef = {
  get: GetFn;
  patchSchema?: z.ZodTypeAny;
  write?: WriteFn;
  readOnly?: boolean;
};

const SLUG_MAP: Record<string, SlugDef> = {
  general: {
    get: (env, config) => ({
      port: config.getNumber('port', 3000),
      logLevel: config.get('logLevel', 'info'),
    }),
    patchSchema: z.object({ logLevel: z.string() }).partial(),
    write: (v, configDir) => {
      const data = v as { logLevel?: string };
      if (data.logLevel !== undefined) mergeConfigYaml(configDir, { logLevel: data.logLevel });
    },
  },

  storage: {
    get: (_env, config) => ({
      wikiRoot: config.get('wikiRoot', './wiki'),
      mcpConfigDir: config.get('mcpConfigDir', './mcp'),
      artifactRoot: config.get('artifactRoot', './artifacts'),
      skillsRoot: config.get('skillsRoot', './skills'),
      database: (() => {
        try {
          const db = config.getSection('database', DatabaseSchema) as { path: string };
          return db ?? { path: 'app.db' };
        } catch {
          return { path: 'app.db' };
        }
      })(),
    }),
    patchSchema: z.object({
      wikiRoot: z.string().optional(),
      mcpConfigDir: z.string().optional(),
      artifactRoot: z.string().optional(),
      skillsRoot: z.string().optional(),
      database: DatabaseSchema.optional(),
    }),
    write: (v, configDir) => {
      const data = v as {
        wikiRoot?: string;
        mcpConfigDir?: string;
        artifactRoot?: string;
        skillsRoot?: string;
        database?: { path: string };
      };
      const updates: Record<string, unknown> = {};
      if (data.wikiRoot !== undefined) updates.wikiRoot = data.wikiRoot;
      if (data.mcpConfigDir !== undefined) updates.mcpConfigDir = data.mcpConfigDir;
      if (data.artifactRoot !== undefined) updates.artifactRoot = data.artifactRoot;
      if (data.skillsRoot !== undefined) updates.skillsRoot = data.skillsRoot;
      if (data.database !== undefined) updates.database = data.database;
      mergeConfigYaml(configDir, updates);
    },
  },

  'model-providers': {
    get: (env) => ({
      providers: env.providers.map((p) => ({
        ...p,
        apiKey: maskApiKey(p.apiKey),
      })),
      defaultProvider: env.defaultProvider,
    }),
    patchSchema: z.object({
      providers: z.array(ProviderSchema).optional(),
      defaultProvider: z.string().optional(),
    }),
    write: (v, configDir, env) => {
      const data = v as { providers?: ProviderConfig[]; defaultProvider?: string };
      const updates: Record<string, unknown> = {};
      if (data.providers !== undefined) {
        const storedByName = new Map(env.providers.map((p) => [p.name, p]));
        updates.providers = data.providers.map((p) => ({
          ...p,
          apiKey: unmaskApiKey(p.apiKey, storedByName.get(p.name)?.apiKey),
        }));
      }
      if (data.defaultProvider !== undefined) updates.defaultProvider = data.defaultProvider;
      mergeConfigYaml(configDir, updates);
    },
  },

  embeddings: {
    get: (env) => ({ ...env.embeddings, apiKey: maskApiKey(env.embeddings.apiKey) }),
    patchSchema: EmbeddingsSchema.partial(),
    write: (v, configDir, env) => {
      const data = v as z.infer<typeof EmbeddingsSchema>;
      const updated = { ...data, apiKey: unmaskApiKey(data.apiKey, env.embeddings.apiKey) };
      mergeConfigYaml(configDir, { embeddings: updated });
    },
  },

  'agent-behavior': {
    get: (env) => ({
      afterAgent: env.afterAgent,
      chat: env.chat,
      observability: env.observability,
    }),
    patchSchema: z.object({
      afterAgent: AfterAgentSchema.partial().optional(),
      chat: ChatSchema.partial().optional(),
      observability: ObservabilitySchema.partial().optional(),
    }),
    write: (v, configDir, env) => {
      const data = v as {
        afterAgent?: Partial<z.infer<typeof AfterAgentSchema>>;
        chat?: Partial<z.infer<typeof ChatSchema>>;
        observability?: Partial<z.infer<typeof ObservabilitySchema>>;
      };
      const updates: Record<string, unknown> = {};
      if (data.afterAgent !== undefined)
        updates.afterAgent = { ...env.afterAgent, ...data.afterAgent };
      if (data.chat !== undefined) updates.chat = { ...env.chat, ...data.chat };
      if (data.observability !== undefined)
        updates.observability = { ...env.observability, ...data.observability };
      mergeConfigYaml(configDir, updates);
    },
  },

  tools: {
    get: (env) => ({
      webFetch: env.webFetch,
      rlm: env.rlm,
      tools: env.tools,
    }),
    patchSchema: z.object({
      webFetch: WebFetchConfigSchema.partial().optional(),
      rlm: RLMConfigSchema.partial().optional(),
      tools: ToolsConfigSchema.partial().optional(),
    }),
    write: (v, configDir, env) => {
      const data = v as {
        webFetch?: Partial<z.infer<typeof WebFetchConfigSchema>>;
        rlm?: Partial<z.infer<typeof RLMConfigSchema>>;
        tools?: Partial<z.infer<typeof ToolsConfigSchema>>;
      };
      const updates: Record<string, unknown> = {};
      if (data.webFetch !== undefined) updates.webFetch = { ...env.webFetch, ...data.webFetch };
      if (data.rlm !== undefined) updates.rlm = { ...env.rlm, ...data.rlm };
      if (data.tools !== undefined) updates.tools = { ...(env.tools ?? {}), ...data.tools };
      mergeConfigYaml(configDir, updates);
    },
  },

  'cost-rates': {
    get: (env) => ({ costs: env.costs }),
    patchSchema: z.object({ costs: z.record(z.string(), CostEntrySchema) }).partial(),
    write: (v, configDir) => {
      const data = v as { costs?: Record<string, CostEntry> };
      if (data.costs !== undefined) mergeConfigYaml(configDir, { costs: data.costs });
    },
  },

  'mcp-servers': {
    get: () => ({}),
    readOnly: true,
  },

  skills: {
    get: () => ({}),
    readOnly: true,
  },
};

// ---- Handler functions -------------------------------------------------------

export function getSettingsSectionHandler(
  slug: string,
  envAccessor: EnvAccessor,
  configAccessor: ConfigManagerAccessor,
): HandlerResult<unknown> {
  const def = SLUG_MAP[slug];
  if (!def) return notFound(`Unknown settings section: ${slug}`);
  try {
    return ok(def.get(envAccessor, configAccessor));
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

export async function patchSettingsSectionHandler(
  slug: string,
  body: unknown,
  configAccessor: ConfigManagerAccessor,
  envAccessor: EnvAccessor,
  loadAgentInstructions: () => Promise<void>,
  invalidateChatAgent: () => void,
  seedProviderCosts: () => void,
): Promise<HandlerResult<unknown>> {
  const def = SLUG_MAP[slug];
  if (!def) return notFound(`Unknown settings section: ${slug}`);
  if (def.readOnly || !def.patchSchema || !def.write) {
    return notFound(`Section "${slug}" does not support PATCH`);
  }

  const parsed = def.patchSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    return invalid('Validation failed', fieldErrors);
  }

  try {
    const configDir = configAccessor.getConfigDir();
    def.write(parsed.data, configDir, envAccessor);
    configAccessor.reload();
    await loadAgentInstructions();
    invalidateChatAgent();
    seedProviderCosts();
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }

  return getSettingsSectionHandler(slug, envAccessor, configAccessor);
}

// ---- Existing reload handler (unchanged) ------------------------------------

export async function reloadSettingsHandler(
  config: { reload: () => void },
  loadAgentInstructions: () => Promise<void>,
  invalidateChatAgent: () => void,
  seedProviderCosts: () => void,
): Promise<{ status: 'ok' }> {
  config.reload();
  await loadAgentInstructions();
  invalidateChatAgent();
  seedProviderCosts();
  return { status: 'ok' };
}
