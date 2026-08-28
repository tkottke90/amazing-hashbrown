import { createApp } from './app.js';
import { loadAgentInstructions } from './config/agent-instructions.js';
import { bootToolsManager } from './services/tools-manager.js';
import { bootObservability } from './services/observability.js';
import { bootShellAudit, getShellAuditWriter } from './services/shell-audit.js';
import { bootUsage, seedProviderCosts } from './services/usage.js';
import { bootEvaluations } from './services/evaluations.js';
import { bootThreadStore } from './services/thread-store.js';
import { bootWorkspaceStore } from './services/workspace-store.js';
import { bootTrackerRegistry } from './services/tracker-registry.js';
import { bootTaskScheduler } from './services/task-scheduler.js';
import { bootKnowledgeBase } from './knowledge-base/index.js';
import { bootArtifactStore } from './artifacts/artifact-store.js';
import { bootSkillsManager, skillsManager } from './services/skills-manager.js';
import { getChatAgent, initChatAgent } from './agents/chat-agent.js';
import { initWikiAgent } from './agents/wiki-ingestion-agent.js';
import { executeTask } from './agents/task-execution.js';
import { env } from './config/env.js';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ShellExecutor, ShellExecutorConfigSchema } from '@tkottke90/shell-executor';

const app = createApp();

// One shared SQLite connection for all stores (WAL mode, foreign keys enabled).
// Future stores (Task System, Persistent Memory) receive the same db instance.
const db = openDatabase(env.database.path);

await bootToolsManager();
app.logger.info('Tools manager booted');
bootObservability(db);
app.logger.info('Observability booted');
bootShellAudit(db);
app.logger.info('Shell audit booted');
bootUsage(db);
seedProviderCosts();
app.logger.info('Usage tracking booted');
bootEvaluations(db);
app.logger.info('Evaluations booted');
bootThreadStore(db);
app.logger.info('Thread store booted');
bootWorkspaceStore(db);
app.logger.info('Workspace store booted');
bootTrackerRegistry();
app.logger.info('Tracker registry booted');
await bootArtifactStore();
app.logger.info('Artifact store booted');
await bootSkillsManager();
app.logger.info('Skills manager booted');
const shellConfig = env.tools?.shell ?? ShellExecutorConfigSchema.parse({});
const trustedExecutor = new ShellExecutor(shellConfig, {
  trustAll: true,
  auditWriter: getShellAuditWriter(),
});
skillsManager.setExecutor(trustedExecutor);
initChatAgent(db);
initWikiAgent(db);
await bootKnowledgeBase();
app.logger.info('Knowledge base booted');
await loadAgentInstructions();
app.logger.info('Agent instructions loaded');

bootTaskScheduler(executeTask);
app.logger.info('Task scheduler started');

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
