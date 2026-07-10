import { createApp } from './app.js';
import { bootToolsManager } from './services/tools-manager.js';
import { getChatAgent } from './agents/chat-agent.js';

const app = createApp();

await bootToolsManager();

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
