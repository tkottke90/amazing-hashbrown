import { loadConfig } from '@tkottke90/config-manager';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  llmBaseUrl: z.string().default('http://localhost:11434'),
  llmModel: z.string().default('llama3'),
  logLevel: z.string().default('info'),
});

// Docker/CI deploy config via process.env, not a config file on disk, so we
// pass those through as runtimeValues and keep the manager read-only.
export const configManager = loadConfig({
  appName: 'amazing-hashbrown-api',
  schema: AppConfigSchema,
  writeBack: false,
  runtimeValues: {
    ...(process.env.PORT && { port: Number(process.env.PORT) }),
    ...(process.env.LLM_BASE_URL && { llmBaseUrl: process.env.LLM_BASE_URL }),
    ...(process.env.LLM_MODEL && { llmModel: process.env.LLM_MODEL }),
    ...(process.env.LOG_LEVEL && { logLevel: process.env.LOG_LEVEL }),
  },
});

export const env = {
  port: configManager.getNumber('port', 3000),
  llmBaseUrl: configManager.get('llmBaseUrl', 'http://localhost:11434'),
  llmModel: configManager.get('llmModel', 'llama3'),
  logLevel: configManager.get('logLevel', 'info'),
};
