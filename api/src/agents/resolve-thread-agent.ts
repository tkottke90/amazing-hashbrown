import { logger } from '../config/logger.js';
import { getWorkspaceStore } from '../services/workspace-store.js';
import { getThreadStore } from '../services/thread-store.js';
import { getChatAgent, getWorkspaceChatAgent, buildTaskAgent } from './chat-agent.js';
import { buildWorkspaceContext, resolveAllowedWikiId } from './workspace-chat-stream-handler.js';
import type { HeadlessAgent } from './headless-turn.js';

// Resolves the agent that should run a system-initiated (headless) turn in
// an existing thread — a sub-agent completion notification or a timed
// wake-up — based on the thread's type. See
// docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §5-6 and
// docs/superpowers/specs/2026-09-27-agent-wait-design.md §3.
// Returns null (logging why) when there is nothing to deliver into: the
// parent thread was deleted, or its type doesn't map to a known agent
// flavor. A global task's own dedicated thread is always type='task' —
// task-execution.ts only ever gives a workspace-scoped task's run
// workspace.threadId (type='workspace-chat') instead, so the 'task' branch
// here never needs a workspace scope.
export interface ResolvedThreadAgent {
  agent: HeadlessAgent;
  workspaceId?: string;
  taskId?: string;
  // The provider/model the thread's user last chose (chat and workspace
  // chat) — undefined means the configured default, as for a new thread.
  provider?: string;
  model?: string;
}

export async function resolveThreadAgent(threadId: string): Promise<ResolvedThreadAgent | null> {
  const store = getWorkspaceStore();
  const threadStore = getThreadStore();
  const meta = threadStore.getThreadMeta(threadId);
  if (!meta) {
    logger.warn('resolve-thread-agent: thread not found, dropping turn', {
      threadId,
    });
    return null;
  }

  // A headless turn continues the conversation on the model its user picked,
  // same as their next interactive message would.
  const provider = meta.provider ?? undefined;
  const model = meta.model ?? undefined;

  switch (meta.type) {
    case 'workspace-chat': {
      const workspace = store.getWorkspaceByThreadId(threadId);
      if (!workspace) {
        logger.warn('resolve-thread-agent: workspace not found for thread', {
          threadId,
        });
        return null;
      }
      const allowedWikiId = resolveAllowedWikiId(store, workspace.id);
      const workspaceContext = await buildWorkspaceContext(workspace);
      const { agent } = await getWorkspaceChatAgent(
        workspace.id,
        workspaceContext,
        provider,
        model,
        allowedWikiId,
      );
      return { agent, workspaceId: workspace.id, provider, model };
    }
    case 'task': {
      const parentTask = store.getTaskByThreadId(threadId);
      if (!parentTask) {
        logger.warn('resolve-thread-agent: task not found for thread', { threadId });
        return null;
      }
      const { agent } = await buildTaskAgent(parentTask);
      return { agent, taskId: parentTask.id };
    }
    case 'chat': {
      const { agent } = await getChatAgent(provider, model);
      return { agent, provider, model };
    }
    default:
      logger.warn('resolve-thread-agent: unsupported thread type, dropping turn', {
        threadId,
        type: meta.type,
      });
      return null;
  }
}
