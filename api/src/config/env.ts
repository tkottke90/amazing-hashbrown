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

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  logLevel: z.string().default('info'),
  wikiRoot: z.string().default('./config/kb'),
  mcpConfigDir: z.string().default('./config'),
  providers: z.array(ProviderSchema).default([]),
  defaultProvider: z.string().default(''),
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
};
