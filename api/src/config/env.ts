import { loadConfig } from '@tkottke90/config-manager';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const ModelPricingSchema = z.object({
  id: z.string(),
  inputPricePerM: z.number().optional(),
  outputPricePerM: z.number().optional(),
});

export type ModelPricingConfig = z.infer<typeof ModelPricingSchema>;

const ProviderSchema = z.object({
  name: z.string(),
  type: z.enum(['ollama', 'openai', 'anthropic']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(ModelPricingSchema).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderSchema>;

const DatabaseSchema = z.object({
  path: z.string().default('app.db'),
});

const ObservabilitySchema = z.object({
  enabled: z.boolean().default(true),
  spanOutputPreviewChars: z.number().default(500),
});

const CostEntrySchema = z.object({
  inputPer1kTokens: z.number().default(0),
  outputPer1kTokens: z.number().default(0),
});

export type CostEntry = z.infer<typeof CostEntrySchema>;

const AfterAgentSchema = z.object({
  enabled: z.boolean().default(true),
});

const ChatSchema = z.object({
  showErrorMessages: z.boolean().default(false),
});

const EmbeddingsSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.enum(['ollama', 'openai']).default('ollama'),
  model: z.string().default('nomic-embed-text'),
  baseUrl: z.string().default('http://localhost:11434/v1'),
  apiKey: z.string().optional(),
});

const RLMConfigSchema = z.object({
  maxIterations: z.number().default(10),
  truncateThreshold: z.number().default(6000),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export type RLMConfig = z.infer<typeof RLMConfigSchema>;

const WebFetchConfigSchema = z.object({
  timeoutMs: z.number().default(10000),
  respectRobotsTxt: z.boolean().default(true),
});

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  logLevel: z.string().default('info'),
  wikiRoot: z.string().default('./wiki'),
  mcpConfigDir: z.string().default('./mcp'),
  artifactRoot: z.string().default('./artifacts'),
  skillsRoot: z.string().default('./skills'),
  providers: z.array(ProviderSchema).default([]),
  defaultProvider: z.string().default(''),
  database: DatabaseSchema.optional(),
  observability: ObservabilitySchema.optional(),
  afterAgent: AfterAgentSchema.optional(),
  chat: ChatSchema.optional(),
  embeddings: EmbeddingsSchema.optional(),
  webFetch: WebFetchConfigSchema.optional(),
  rlm: RLMConfigSchema.optional(),
  costs: z.record(z.string(), CostEntrySchema).default({}),
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
  get webFetch(): z.infer<typeof WebFetchConfigSchema> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('webFetch', WebFetchConfigSchema) as z.infer<
        typeof WebFetchConfigSchema
      >;
    } catch {
      return WebFetchConfigSchema.parse({});
    }
  },
  get rlm(): RLMConfig {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (configManager as any).getSection('rlm', RLMConfigSchema) as RLMConfig;
    } catch {
      return RLMConfigSchema.parse({});
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
};
