import path from 'path';
import { loadConfig } from '@tkottke90/config-manager';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const ProviderSchema = z.object({
  name: z.string(),
  type: z.enum(['ollama', 'openai', 'anthropic']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
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

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  logLevel: z.string().default('info'),
  wikiRoot: z.string().default('./config/kb'),
  mcpConfigDir: z.string().default('./config'),
  providers: z.array(ProviderSchema).default([]),
  defaultProvider: z.string().default(''),
  database: DatabaseSchema.optional(),
  observability: ObservabilitySchema.optional(),
  afterAgent: AfterAgentSchema.optional(),
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
    return configManager.get('wikiRoot', './config/kb') as string;
  },
  get mcpConfigDir() {
    return configManager.get('mcpConfigDir', './config') as string;
  },
  get providers() {
    return (configManager.get('providers', []) ?? []) as ProviderConfig[];
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
      if (path.isAbsolute(raw.path)) return raw;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const configDir = (configManager as any).getConfigDir() as string;
      return { ...raw, path: path.join(configDir, raw.path) };
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
  get costs(): Record<string, CostEntry> {
    return (configManager.get('costs', {}) ?? {}) as Record<string, CostEntry>;
  },
};
