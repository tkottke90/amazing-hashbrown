import { randomUUID } from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger, serializeError } from '../../config/logger.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import { getThreadStore } from '../../services/thread-store.js';
import { recordSubAgentMarker } from '../thread-message-writer.js';

const SpawnSubAgentSchema = z.object({
  role: z.string().describe('The sub-agent role to delegate to — one of the configured roles.'),
  goal: z
    .string()
    .describe(
      'What the sub-agent should accomplish. Be specific and self-contained — the sub-agent ' +
        'starts with no context beyond this goal and has no way to ask you follow-up questions.',
    ),
});

// Fire-and-forget dispatch only: this never awaits the sub-agent's
// execution. Provider/model are resolved from `role` server-side — the
// schema above intentionally exposes no provider/model field, so the
// calling model has no path to choose its own infra (overspend guard). See
// docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §3-4.

// Sibling correlation for "spawn several sub-agents in one dispatch": every
// spawn_sub_agent call issued from the same AIMessage's parallel tool_calls
// batch shares an identical config.metadata.langgraph_checkpoint_ns (or,
// failing that, langgraph_step) — LangGraph's ToolNode passes the same
// config object reference to every sibling call in a batch, and mints a new
// one for the next round/turn. Keying a short-lived Map by thread+batch
// lets N same-turn calls share one dispatchGroupId without any explicit
// count/array parameter on the tool schema itself. TTL eviction is a safety
// net, not real coordination — a batch of tool calls resolves in
// milliseconds, well under BATCH_TTL_MS.
const BATCH_TTL_MS = 30_000;
const _dispatchGroups = new Map<string, { id: string; expiresAt: number }>();

function sweepExpiredBatches(now: number): void {
  for (const [key, entry] of _dispatchGroups) {
    if (entry.expiresAt <= now) _dispatchGroups.delete(key);
  }
}

// Exported for direct testing (same rationale as buildWikiWriteTools() in
// chat-agent.ts) — simulating LangGraph's real config.metadata shape end to
// end would require standing up a whole graph run.
export function resolveDispatchGroupId(
  threadId: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const now = Date.now();
  sweepExpiredBatches(now);

  const batchKey = metadata?.langgraph_checkpoint_ns ?? metadata?.langgraph_step;
  if (batchKey === undefined) {
    // No LangGraph batch metadata available (e.g. a direct/unit-test
    // invocation) — give it its own group rather than guessing at siblings.
    return randomUUID();
  }

  const key = `${threadId}:${String(batchKey)}`;
  const existing = _dispatchGroups.get(key);
  if (existing) {
    existing.expiresAt = now + BATCH_TTL_MS;
    return existing.id;
  }
  const id = randomUUID();
  _dispatchGroups.set(key, { id, expiresAt: now + BATCH_TTL_MS });
  return id;
}

export const spawnSubAgentTool = tool(
  async ({ role, goal }, config) => {
    const roleConfig = env.roles[role];
    if (!roleConfig) {
      const available = Object.keys(env.roles);
      return available.length
        ? `Unknown role "${role}". Configured roles: ${available.join(', ')}.`
        : `Unknown role "${role}". No sub-agent roles are configured.`;
    }

    const parentThreadId = config?.configurable?.thread_id as string | undefined;
    if (!parentThreadId) {
      return 'Cannot spawn a sub-agent: no active thread to report the result back to.';
    }
    const workspaceId = config?.configurable?.workspaceId as string | undefined;
    const metadata = config?.metadata as Record<string, unknown> | undefined;
    const dispatchGroupId = resolveDispatchGroupId(parentThreadId, metadata);

    let task;
    try {
      task = getWorkspaceStore().createSubAgentTask({
        role,
        goal,
        parentThreadId,
        dispatchGroupId,
        workspaceId: workspaceId ?? null,
      });
    } catch (err) {
      logger.error('spawn_sub_agent: dispatch failed', { role, err: serializeError(err) });
      return `Failed to dispatch sub-agent: ${(err as Error).message}`;
    }

    getTaskScheduler().wake();

    recordSubAgentMarker(getThreadStore(), parentThreadId, randomUUID(), {
      taskId: task.id,
      role,
      phase: 'dispatch',
    });

    return JSON.stringify({ dispatched: { id: task.id, role } });
  },
  {
    name: 'spawn_sub_agent',
    description:
      'Delegate a subtask to a fresh, isolated sub-agent run on a fixed provider/model resolved ' +
      'from the given role (never one you choose yourself). Dispatch is fire-and-forget: this ' +
      "returns immediately with the sub-agent's task id, and its result arrives later as a new " +
      'message in this thread — do not wait for it. Call this more than once in the same turn to ' +
      'spawn several sibling sub-agents at once; they are grouped together and each completion ' +
      'reports how many siblings are still running. The sub-agent has read-only tools only and ' +
      'cannot spawn further sub-agents itself.',
    schema: SpawnSubAgentSchema,
  },
);
