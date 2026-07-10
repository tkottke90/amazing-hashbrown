import path from 'node:path';
import { loadConfig } from '@tkottke90/config-manager';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const AppConfigSchema = z.object({
  port: z.number().default(3000),
  llmBaseUrl: z.string().default('http://localhost:11434'),
  llmModel: z.string().default('llama3'),
  logLevel: z.string().default('info'),
  wikiRoot: z.string().default('./config/kb'),
  mcpConfigDir: z.string().default('./config'),
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
    ...(process.env.WIKI_ROOT && { wikiRoot: process.env.WIKI_ROOT }),
    // MCP_CONFIG_PATH points to the mcp.json file; derive the directory from it.
    ...(process.env.MCP_CONFIG_PATH && {
      mcpConfigDir: path.dirname(process.env.MCP_CONFIG_PATH),
    }),
  },
});

export const env = {
  port: configManager.getNumber('port', 3000),
  llmBaseUrl: configManager.get('llmBaseUrl', 'http://localhost:11434'),
  llmModel: configManager.get('llmModel', 'llama3'),
  logLevel: configManager.get('logLevel', 'info'),
  wikiRoot: configManager.get('wikiRoot', './config/kb'),
  mcpConfigDir: configManager.get('mcpConfigDir', './config'),
};
