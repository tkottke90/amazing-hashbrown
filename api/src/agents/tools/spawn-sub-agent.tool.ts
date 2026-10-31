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
  role: z
    .string()
    .optional()
    .describe(
      'The sub-agent role to delegate to — one of the configured roles. Omit it, or pass an ' +
        'unknown name, to use the Default Role.',
    ),
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

// Resolves a requested role (possibly absent, empty, or unknown) against
// the configured Roles, falling back to agent.defaultRole — never erroring
// as long as *some* usable Role can be found (the boot-time backfill in
// roles.handlers.ts's ensureDefaultRole() guarantees at least one always
// exists; see ADR-0049/ADR-0050). Returns null only when no usable Role
// exists at all, which should be unreachable outside a direct bug.
function resolveRole(requested: string | undefined): {
  roleName: string;
  usedFallback: boolean;
  originalRole?: string;
} | null {
  const roles = env.agent.roles;
  const trimmed = requested?.trim();
  if (trimmed && roles[trimmed]) return { roleName: trimmed, usedFallback: false };

  const defaultRoleName = env.agent.defaultRole;
  if (defaultRoleName && roles[defaultRoleName]) {
    return { roleName: defaultRoleName, usedFallback: true, originalRole: trimmed || undefined };
  }
  return null;
}

export const spawnSubAgentTool = tool(
  async ({ role, goal }, config) => {
    const resolved = resolveRole(role);
    if (!resolved) {
      const available = Object.keys(env.agent.roles);
      return available.length
        ? `Unknown role "${role ?? ''}". Configured roles: ${available.join(', ')}.`
        : `Unknown role "${role ?? ''}". No sub-agent roles are configured.`;
    }
    const { roleName, usedFallback, originalRole } = resolved;

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
        role: roleName,
        goal,
        parentThreadId,
        dispatchGroupId,
        workspaceId: workspaceId ?? null,
      });
    } catch (err) {
      logger.error('spawn_sub_agent: dispatch failed', { role: roleName, err: serializeError(err) });
      return `Failed to dispatch sub-agent: ${(err as Error).message}`;
    }

    getTaskScheduler().wake();

    recordSubAgentMarker(getThreadStore(), parentThreadId, randomUUID(), {
      taskId: task.id,
      role: roleName,
      phase: 'dispatch',
    });

    const payload: Record<string, unknown> = { dispatched: { id: task.id, role: roleName } };
    if (usedFallback) {
      const available = Object.keys(env.agent.roles);
      payload['notice'] = originalRole
        ? `Unknown role "${originalRole}" — dispatched to the Default Role "${roleName}" instead. ` +
          `Configured roles: ${available.join(', ')}.`
        : `No role was given — dispatched to the Default Role "${roleName}". ` +
          `Configured roles: ${available.join(', ')}.`;
    }
    return JSON.stringify(payload);
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
