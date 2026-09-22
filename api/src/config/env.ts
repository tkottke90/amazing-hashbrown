import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@tkottke90/config-manager';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

export const ModelPricingSchema = z.object({
  id: z.string(),
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
});

export type ModelPricingConfig = z.infer<typeof ModelPricingSchema>;

export const ProviderSchema = z.object({
  name: z.string(),
  type: z.enum(['ollama', 'openai', 'anthropic']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(ModelPricingSchema).optional(),
  // -1 = unlimited (bypasses the provider-queue gate entirely). Optional
  // rather than z.default(1) — a schema default would make this a required
  // key on the inferred ProviderConfig output type, breaking every existing
  // object literal built without it (provider-factory.test.ts,
  // providers.route.ts). Consumers (provider-queue.ts) fall back to 1
  // themselves, same pattern as defaultModel/apiKey above.
  maxConcurrency: z.number().int().optional(),
  // Bounds a single outbound LLM HTTP call (not a whole multi-tool-call
  // agent turn, which legitimately makes many bounded calls in sequence) —
  // the safety net for an interactive chat turn nobody ever explicitly
  // Stops. See docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md §6.
  // Optional for the same reason maxConcurrency is above.
  timeoutMs: z.number().int().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const DatabaseSchema = z.object({
  path: z.string().default('./app.db'),
});

export const ObservabilitySchema = z.object({
  enabled: z.boolean().default(true),
  spanOutputPreviewChars: z.number().default(500),
});

export const CostEntrySchema = z.object({
  inputPer1kTokens: z.number().default(0),
  inputScale: z.enum(['1k', '1M']).default('1k'),
  outputPer1kTokens: z.number().default(0),
  outputScale: z.enum(['1k', '1M']).default('1k'),
});

export type CostEntry = z.infer<typeof CostEntrySchema>;

export const AfterAgentSchema = z.object({
  enabled: z.boolean().default(true),
});

export const ContextWindowSchema = z.object({
  enabled: z.boolean().default(true),
  maxTokens: z.number().default(32000),
  // Fraction of maxTokens the trimmer actually targets — absorbs the char/4
  // estimator's systematic undercount on dense structured content (tool
  // schemas) without a second, separately-tuned calibration knob. See
  // docs/superpowers/specs/2026-09-04-context-window-tool-schema-overhead-design.md.
  safetyMarginPct: z.number().default(0.85),
});

export const ConversationSearchSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().default(20),
});

export const WorkspaceSummarySchema = z.object({
  enabled: z.boolean().default(true),
  messageThreshold: z.number().default(40),
});

export const ChatSchema = z.object({
  showErrorMessages: z.boolean().default(false),
  contextWindow: ContextWindowSchema.optional(),
  conversationSearch: ConversationSearchSchema.optional(),
  workspaceSummary: WorkspaceSummarySchema.optional(),
});

export const EmbeddingsSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.enum(['ollama', 'openai']).default('ollama'),
  model: z.string().default('nomic-embed-text'),
  baseUrl: z.string().default('http://localhost:11434/v1'),
  apiKey: z.string().optional(),
});

export const RLMConfigSchema = z.object({
  maxIterations: z.number().default(10),
  truncateThreshold: z.number().default(6000),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export type RLMConfig = z.infer<typeof RLMConfigSchema>;

// A named sub-agent "role" (spawn_sub_agent tool) — a fixed provider/model
// resolved server-side at dispatch time, never a parameter the calling model
// supplies. See docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §3.
export const RoleSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const RolesConfigSchema = z.record(z.string(), RoleSchema).default({});

export type RoleConfig = z.infer<typeof RoleSchema>;

export const AgentSchema = z.object({
  recursionLimit: z.number().int().positive().default(100),
  recursionWarnThreshold: z.number().min(0.1).max(0.99).default(0.75),
  // A sub-agent run gets a much smaller hard ceiling than an interactive/task
  // agent — it has no soft-interrupt recursion-guard middleware (that uses
  // interrupt(), which would suspend a graph nothing is watching to resume),
  // so this is its only backstop against runaway looping.
  subAgentRecursionLimit: z.number().int().positive().default(25),
});

export type AgentConfig = z.infer<typeof AgentSchema>;

export const ArtifactGcSchema = z.object({
  // How long a user-uploaded artifact must sit unreferenced before the
  // GC sweep will delete it — long enough that stepping away mid-compose
  // for a few hours doesn't lose a staged upload.
  graceMs: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  // How often the sweep runs — a separate knob from graceMs, since how
  // often to check and how old something must be are different concerns.
  intervalMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
});

export type ArtifactGcConfig = z.infer<typeof ArtifactGcSchema>;

export const WebFetchConfigSchema = z.object({
  timeoutMs: z.number().default(10000),
  respectRobotsTxt: z.boolean().default(true),
});

// Per-tool config.yaml entry — flat `tools.<toolId>` map (issue #171/#63/#154
// redesign; docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md
// §3). Every tool (built-in, wiki, skill-gated, mcp) can have an entry here;
// most won't. Generic fields cover the enable/default-include/description/
// instructions state every tool shares; the catchall carries the handful of
// tool-specific extra fields (web_fetch's timeoutMs/respectRobotsTxt,
// rlm_query's provider/model/maxIterations/truncateThreshold, shell_exec's
// allowlist/denylist) without a rigid nested schema — each is validated
// against its own typed schema only where it's actually written
// (tool-settings.handlers.ts), not here.
export const ToolDefaultIncludeSchema = z.object({
  chat: z.boolean().optional(),
  subAgent: z.boolean().optional(),
  autonomous: z.boolean().optional(),
});

export const ToolEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultInclude: ToolDefaultIncludeSchema.optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
  })
  .catchall(z.unknown());

export type ToolEntry = z.infer<typeof ToolEntrySchema>;

export const ToolsConfigSchema = z.record(z.string(), ToolEntrySchema).default({});

export const GithubTrackerSchema = z.object({
  token: z.string().optional(),
});

export const TrackersConfigSchema = z.object({
  github: GithubTrackerSchema.optional(),
});

export const TasksConfigSchema = z.object({
  trackers: TrackersConfigSchema.optional(),
});

export const WorkspacesSchema = z.object({
  tasks: TasksConfigSchema.optional(),
});

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  logLevel: z.string().default('info'),
  wikiRoot: z.string().default('./wiki'),
  mcpConfigDir: z.string().default('./mcp'),
  artifactRoot: z.string().default('./artifacts'),
  skillsRoot: z.string().default('./skills'),
  projectsRoot: z.string().default('./projects'),
  tempProjectsRoot: z.string().optional(),
  providers: z.array(ProviderSchema).default([]),
  defaultProvider: z.string().default(''),
  database: DatabaseSchema.optional(),
  observability: ObservabilitySchema.optional(),
  afterAgent: AfterAgentSchema.optional(),
  chat: ChatSchema.optional(),
  embeddings: EmbeddingsSchema.optional(),
  agent: AgentSchema.optional(),
  artifactGc: ArtifactGcSchema.optional(),
  costs: z.record(z.string(), CostEntrySchema).default({}),
  tools: ToolsConfigSchema,
  workspaces: WorkspacesSchema.optional(),
  roles: RolesConfigSchema.optional(),
});

// config.yaml is the primary config source. Use ${ENV_VAR} syntax in the file
// to reference environment variables. CONFIG_DIR overrides the config directory.
export const configManager = loadConfig({
  appName: 'amazing-hashbrown-api',
  schema: AppConfigSchema,
  configDir: process.env.CONFIG_DIR ?? './config',
  writeBack: true,
});

// Getter-based so values refresh automatically after configManager.reload().
export const env = {
  get port() {
    return configManager.getNumber('port', 3000) as number;
  },
  get logLevel() {
    return configManager.get('logLevel', 'info') as string;
  },
  get wikiRoot() {
    return configManager.getConfigDir(configManager.get('wikiRoot') as string);
  },
  get mcpConfigDir() {
    return configManager.getConfigDir(configManager.get('mcpConfigDir') as string);
  },
  get artifactRoot() {
    return configManager.getConfigDir(configManager.get('artifactRoot') as string);
  },
  get skillsRoot() {
    return configManager.getConfigDir(configManager.get('skillsRoot') as string);
  },
  get projectsRoot() {
    return configManager.getConfigDir(configManager.get('projectsRoot') as string);
  },
  get tempProjectsRoot() {
    const configured = configManager.get('tempProjectsRoot') as string | undefined;
    return configured || path.join(os.tmpdir(), 'projects');
  },
  get providers(): ProviderConfig[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection(
        'providers',
        z.array(ProviderSchema),
      ) as ProviderConfig[];
    } catch {
      return [];
    }
  },
  get defaultProvider() {
    return (configManager.get('defaultProvider', '') ?? '') as string;
  },
  get database(): z.infer<typeof DatabaseSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (configManager as any).getSection('database', DatabaseSchema) as z.infer<
        typeof DatabaseSchema
      >;
      return { ...raw, path: configManager.getConfigDir() + '/' + raw.path };
    } catch {
      return DatabaseSchema.parse({});
    }
  },
  get observability(): z.infer<typeof ObservabilitySchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('observability', ObservabilitySchema) as z.infer<
        typeof ObservabilitySchema
      >;
    } catch {
      return ObservabilitySchema.parse({});
    }
  },
  get afterAgent(): z.infer<typeof AfterAgentSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('afterAgent', AfterAgentSchema) as z.infer<
        typeof AfterAgentSchema
      >;
    } catch {
      return AfterAgentSchema.parse({});
    }
  },
  get chat(): z.infer<typeof ChatSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('chat', ChatSchema) as z.infer<typeof ChatSchema>;
    } catch {
      return ChatSchema.parse({});
    }
  },
  get embeddings(): z.infer<typeof EmbeddingsSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('embeddings', EmbeddingsSchema) as z.infer<
        typeof EmbeddingsSchema
      >;
    } catch {
      return EmbeddingsSchema.parse({});
    }
  },
  // web_fetch/rlm_query's config now lives at tools.web_fetch/tools.rlm_query
  // (closes issue #63 — no longer top-level, co-located with every other
  // tool's config) — these two getters keep the same narrow, convenient
  // shape their one-each call sites (web-fetch.ts, wiki-read-page.tool.ts,
  // rlm-query.tool.ts) already use, just repointed to the new location.
  get webFetch(): z.infer<typeof WebFetchConfigSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools = (configManager as any).getSection('tools', ToolsConfigSchema) as Record<
        string,
        ToolEntry
      >;
      return WebFetchConfigSchema.parse(tools['web_fetch'] ?? {});
    } catch {
      return WebFetchConfigSchema.parse({});
    }
  },
  get rlm(): RLMConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools = (configManager as any).getSection('tools', ToolsConfigSchema) as Record<
        string,
        ToolEntry
      >;
      return RLMConfigSchema.parse(tools['rlm_query'] ?? {});
    } catch {
      return RLMConfigSchema.parse({});
    }
  },
  get agent(): AgentConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('agent', AgentSchema) as AgentConfig;
    } catch {
      return AgentSchema.parse({});
    }
  },
  get artifactGc(): ArtifactGcConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('artifactGc', ArtifactGcSchema) as ArtifactGcConfig;
    } catch {
      return ArtifactGcSchema.parse({});
    }
  },
  get costs(): Record<string, CostEntry> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection(
        'costs',
        z.record(z.string(), CostEntrySchema),
      ) as Record<string, CostEntry>;
    } catch {
      return {};
    }
  },
  get roles(): Record<string, RoleConfig> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('roles', RolesConfigSchema) as Record<
        string,
        RoleConfig
      >;
    } catch {
      return {};
    }
  },
  // Raw per-tool config map, keyed by toolId — the resolver
  // (api/src/agents/tool-config.ts) is the only place that should read
  // arbitrary toolId entries out of this; other call sites needing one
  // specific tool's config (shell, web fetch, rlm) go through a narrower
  // convenience getter instead (see webFetch/rlm above, and shell_exec's
  // own read at its two call sites).
  get tools(): Record<string, ToolEntry> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('tools', ToolsConfigSchema) as Record<
        string,
        ToolEntry
      >;
    } catch {
      return {};
    }
  },
  get workspaces(): z.infer<typeof WorkspacesSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('workspaces', WorkspacesSchema) as z.infer<
        typeof WorkspacesSchema
      >;
    } catch {
      return WorkspacesSchema.parse({});
    }
  },
};
