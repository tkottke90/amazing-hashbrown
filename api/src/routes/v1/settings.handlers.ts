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
  ProviderSchema,
  FavoriteModelSchema,
  CostEntrySchema,
  GithubTrackerSchema,
  WorkspacesSchema,
  type ProviderConfig,
  type FavoriteModel,
  type CostEntry,
  type RLMConfig,
} from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { describeCredential, validateCredentialValue } from '../../config/credential-value.js';

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
  favoriteModels: FavoriteModel[];
  database: { path: string };
  observability: z.infer<typeof ObservabilitySchema>;
  afterAgent: z.infer<typeof AfterAgentSchema>;
  chat: z.infer<typeof ChatSchema>;
  embeddings: z.infer<typeof EmbeddingsSchema>;
  webFetch: z.infer<typeof WebFetchConfigSchema>;
  rlm: RLMConfig;
  costs: Record<string, CostEntry>;
  workspaces: z.infer<typeof WorkspacesSchema>;
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

// A credential field (git-credentials/trackers github token) may be unset,
// a literal secret, or a ${VAR} reference — the last of those is safe to
// show verbatim (it's not the secret), so only the literal case reuses the
// MASK sentinel above.
function displayCredential(raw: string | undefined): string | undefined {
  const display = describeCredential(raw);
  if (display.mode === 'unset') return undefined;
  if (display.mode === 'env') return `\${${display.name}}`;
  return MASK;
}

// ---- YAML config write -------------------------------------------------------

// Exported for reuse by tool-settings.handlers.ts, which needs the same
// read/merge-into-config.yaml primitive for its own nested `tools.<toolId>`
// writes (a shallow top-level merge alone would wholesale replace the
// entire tools map, so that handler builds its own deep-merged `tools`
// value before calling mergeConfigYaml, same as every write() below does
// for its own section).
export function readConfigYaml(configDir: string): Record<string, unknown> {
  const configPath = nodePath.join(configDir, 'config.yaml');
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf8');
  return (yaml.parse(raw) as Record<string, unknown>) ?? {};
}

export function mergeConfigYaml(configDir: string, updates: Record<string, unknown>): void {
  const configPath = nodePath.join(configDir, 'config.yaml');
  const current = readConfigYaml(configDir);
  const merged = { ...current, ...updates };
  fs.writeFileSync(configPath, yaml.stringify(merged), 'utf8');
}

// The `workspaces` section exactly as written in config.yaml, lookups
// unresolved — mirrors tool-settings.handlers.ts's readRawToolsConfig()
// for the same reason (issue #220): building a settings response, or the
// "currently stored value" used to resolve the MASK sentinel on write,
// from the resolved env.workspaces getter would either leak a resolved
// secret or silently replace a stored ${VAR} reference with its resolved
// literal value. Both the `trackers` and `git-credentials` slugs below
// read through this instead of env.workspaces, and both must merge their
// write into the *whole* object this returns — mergeConfigYaml()'s
// top-level merge would otherwise let one slug's save wipe out the other's
// subtree, since both live under the same `workspaces` key.
export function readRawWorkspacesConfig(configDir: string): z.infer<typeof WorkspacesSchema> {
  const parsed = WorkspacesSchema.safeParse(readConfigYaml(configDir)['workspaces']);
  if (!parsed.success) {
    logger.warn('config.yaml workspaces section failed validation; showing defaults', {
      issues: parsed.error.issues.map((i) => i.message),
    });
    return {};
  }
  return parsed.data;
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
  favoriteModels: FavoriteModel[];
};

export type EmbeddingsSettings = z.infer<typeof EmbeddingsSchema>;

export type AgentBehaviorSettings = {
  afterAgent: z.infer<typeof AfterAgentSchema>;
  chat: z.infer<typeof ChatSchema>;
  observability: z.infer<typeof ObservabilitySchema>;
};

export type CostRatesSettings = { costs: Record<string, CostEntry> };

export type TrackersSettings = { github: z.infer<typeof GithubTrackerSchema> };

export type GitCredentialsSettings = { github: z.infer<typeof GithubTrackerSchema> };

// ---- Slug definitions ---------------------------------------------------------

type GetFn = (env: EnvAccessor, config: ConfigManagerAccessor) => unknown;
type WriteFn = (validated: unknown, configDir: string, env: EnvAccessor) => void;
// Cross-field checks patchSchema can't express on its own (e.g. a value
// referencing another field or stored config). Runs after patchSchema
// succeeds and before write; a non-null result is returned as a 400 with
// these field errors and nothing is written.
type ValidateFn = (validated: unknown, env: EnvAccessor) => Record<string, string[]> | null;

type SlugDef = {
  get: GetFn;
  patchSchema?: z.ZodTypeAny;
  validate?: ValidateFn;
  write?: WriteFn;
  readOnly?: boolean;
};

// Every favorite must name a configured provider, and each provider/model
// pair may appear once. Models are deliberately not checked: that needs a
// live call to the provider, which may simply be down (a router provider's
// model list also changes without notice) — stale models are surfaced in
// the UI instead. See docs/superpowers/specs/2026-09-27-favorite-models-design.md.
export function validateFavoriteModels(
  favorites: FavoriteModel[],
  providerNames: string[],
): string[] {
  const known = new Set(providerNames);
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const f of favorites) {
    if (!known.has(f.provider)) {
      errors.push(
        `Favorite "${f.provider} / ${f.model}" references unknown provider "${f.provider}"`,
      );
    }
    const key = JSON.stringify([f.provider, f.model]);
    if (seen.has(key)) errors.push(`Duplicate favorite "${f.provider} / ${f.model}"`);
    seen.add(key);
  }
  return errors;
}

// Shared by the `trackers` and `git-credentials` slugs below — both patch
// a single `{ github: { token } }` shape. Skips validation for the MASK
// sentinel/undefined (an unchanged or cleared field), and otherwise checks
// a ${VAR}-shaped token against validateCredentialValue (config/credential-value.ts).
function validateGithubTokenField(v: unknown): Record<string, string[]> | null {
  const data = v as { github?: { token?: string } };
  const token = data.github?.token;
  if (token === undefined || token === MASK) return null;
  const error = validateCredentialValue(token);
  return error ? { 'github.token': [error] } : null;
}

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
      favoriteModels: env.favoriteModels,
    }),
    patchSchema: z.object({
      providers: z.array(ProviderSchema).optional(),
      defaultProvider: z.string().optional(),
      favoriteModels: z.array(FavoriteModelSchema).optional(),
    }),
    validate: (v, env) => {
      const data = v as { providers?: ProviderConfig[]; favoriteModels?: FavoriteModel[] };
      if (data.providers === undefined && data.favoriteModels === undefined) return null;
      // Validate against the post-patch state: incoming values where the
      // body has them, stored values otherwise — so changing providers
      // alone can't silently orphan the stored favorites.
      const providers = data.providers ?? env.providers;
      const favorites = data.favoriteModels ?? env.favoriteModels;
      const errors = validateFavoriteModels(
        favorites,
        providers.map((p) => p.name),
      );
      return errors.length > 0 ? { favoriteModels: errors } : null;
    },
    write: (v, configDir, env) => {
      const data = v as {
        providers?: ProviderConfig[];
        defaultProvider?: string;
        favoriteModels?: FavoriteModel[];
      };
      const updates: Record<string, unknown> = {};
      if (data.providers !== undefined) {
        const storedByName = new Map(env.providers.map((p) => [p.name, p]));
        updates.providers = data.providers.map((p) => ({
          ...p,
          apiKey: unmaskApiKey(p.apiKey, storedByName.get(p.name)?.apiKey),
        }));
      }
      if (data.defaultProvider !== undefined) updates.defaultProvider = data.defaultProvider;
      if (data.favoriteModels !== undefined) updates.favoriteModels = data.favoriteModels;
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

  // 'tools' slug removed — webFetch/rlm/shell config moved into per-tool
  // config.yaml entries (tools.<toolId>), managed via
  // GET/PATCH/DELETE /api/v1/tool-settings/:toolId (tool-settings.handlers.ts)
  // instead of this batched form. See
  // docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §4/§6.

  'cost-rates': {
    get: (env) => ({ costs: env.costs }),
    patchSchema: z.object({ costs: z.record(z.string(), CostEntrySchema) }).partial(),
    write: (v, configDir) => {
      const data = v as { costs?: Record<string, CostEntry> };
      if (data.costs !== undefined) mergeConfigYaml(configDir, { costs: data.costs });
    },
  },

  trackers: {
    get: (_env, config) => {
      const raw = readRawWorkspacesConfig(config.getConfigDir());
      return { github: { token: displayCredential(raw.tasks?.trackers?.github?.token) } };
    },
    patchSchema: z.object({ github: GithubTrackerSchema.partial().optional() }).partial(),
    validate: (v) => validateGithubTokenField(v),
    write: (v, configDir) => {
      const data = v as { github?: { token?: string } };
      const current = readRawWorkspacesConfig(configDir);
      const token = unmaskApiKey(data.github?.token, current.tasks?.trackers?.github?.token);
      mergeConfigYaml(configDir, {
        workspaces: {
          ...current,
          tasks: { ...current.tasks, trackers: { ...current.tasks?.trackers, github: { token } } },
        },
      });
    },
  },

  // Authenticates workspace/project git clone/fetch/sync/push over HTTPS —
  // deliberately a separate stored value from `trackers.github.token`
  // above (one authenticates git itself, the other the issue-tracker API);
  // see api/src/services/git-credentials.ts for where it's consumed.
  'git-credentials': {
    get: (_env, config) => {
      const raw = readRawWorkspacesConfig(config.getConfigDir());
      return { github: { token: displayCredential(raw.git?.github?.token) } };
    },
    patchSchema: z.object({ github: GithubTrackerSchema.partial().optional() }).partial(),
    validate: (v) => validateGithubTokenField(v),
    write: (v, configDir) => {
      const data = v as { github?: { token?: string } };
      const current = readRawWorkspacesConfig(configDir);
      const token = unmaskApiKey(data.github?.token, current.git?.github?.token);
      mergeConfigYaml(configDir, {
        workspaces: { ...current, git: { ...current.git, github: { token } } },
      });
    },
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
  reloadTrackerRegistry: () => void,
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

  const crossFieldErrors = def.validate?.(parsed.data, envAccessor);
  if (crossFieldErrors) return invalid('Validation failed', crossFieldErrors);

  try {
    const configDir = configAccessor.getConfigDir();
    def.write(parsed.data, configDir, envAccessor);
    configAccessor.reload();
    await loadAgentInstructions();
    invalidateChatAgent();
    seedProviderCosts();
    reloadTrackerRegistry();
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
  reloadTrackerRegistry: () => void,
): Promise<{ status: 'ok' }> {
  config.reload();
  await loadAgentInstructions();
  invalidateChatAgent();
  seedProviderCosts();
  reloadTrackerRegistry();
  return { status: 'ok' };
}
