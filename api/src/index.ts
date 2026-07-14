import { createApp } from './app.js';
import { bootToolsManager } from './services/tools-manager.js';
import { bootObservability } from './services/observability.js';
import { getChatAgent } from './agents/chat-agent.js';
import { env } from './config/env.js';
import { openDatabase } from '@tkottke90/llm-common-types/db';

const app = createApp();

// One shared SQLite connection for all stores (WAL mode, foreign keys enabled).
// Future stores (Task System, Persistent Memory) receive the same db instance.
const db = openDatabase(env.database.path);

await bootToolsManager();
bootObservability(db);

app.start();

// Warm up MCP connections immediately after boot so the Docker gateway is
// ready before the first request, rather than delaying it.
getChatAgent().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  app.logger.warn('Chat agent warm-up failed', { err: message });
});

process.on('exit', (code) => {
  app.logger.info(`Process exiting with code ${code}`);
});
