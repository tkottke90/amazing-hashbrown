import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { CheckpointMetadata, CheckpointTuple, PendingWrite } from '@langchain/langgraph-checkpoint';

// Forks the checkpoint chain for a thread — no library-provided "clone a
// thread" API exists in the OSS LangGraph checkpointer (see
// docs/Design/2026-07-18-persistent-conversation-memory-design.md's fork
// mechanics section). Naively copying only the latest checkpoint via
// getTuple()+put() loses the parent chain and any pending writes, which can
// leave the forked thread unable to resume correctly. This walks the full
// ancestor chain from targetCheckpointId back to the root and replays each
// checkpoint (plus its pending writes) under newThreadId, preserving
// checkpoint ids and parent linkage exactly.
export async function forkThreadCheckpoints(
  checkpointer: SqliteSaver,
  sourceThreadId: string,
  targetCheckpointId: string,
  newThreadId: string,
): Promise<void> {
  const byId = new Map<string, CheckpointTuple>();
  for await (const tuple of checkpointer.list({ configurable: { thread_id: sourceThreadId } })) {
    byId.set(tuple.checkpoint.id, tuple);
  }

  const target = byId.get(targetCheckpointId);
  if (!target) {
    throw new Error(`Checkpoint "${targetCheckpointId}" not found on thread "${sourceThreadId}"`);
  }

  // Walk parentConfig back to the root, then reverse to chronological order.
  // Walking the explicit parent chain (rather than assuming "every checkpoint
  // with id <= target is an ancestor") is deliberately more conservative —
  // correct even if the source thread itself already contains more than one
  // branch (e.g. it was itself forked from).
  const chain: CheckpointTuple[] = [];
  const seen = new Set<string>();
  let current: CheckpointTuple | undefined = target;
  while (current) {
    if (seen.has(current.checkpoint.id)) {
      throw new Error(`Checkpoint chain cycle detected at "${current.checkpoint.id}"`);
    }
    seen.add(current.checkpoint.id);
    chain.push(current);
    const parentId = current.parentConfig?.configurable?.['checkpoint_id'] as string | undefined;
    current = parentId ? byId.get(parentId) : undefined;
  }
  chain.reverse();

  for (const tuple of chain) {
    const checkpointNs = (tuple.config.configurable?.['checkpoint_ns'] as string | undefined) ?? '';
    const parentCheckpointId = tuple.parentConfig?.configurable?.['checkpoint_id'] as
      | string
      | undefined;

    const metadata: CheckpointMetadata = tuple.metadata
      ? { ...tuple.metadata, source: 'fork' }
      : { source: 'fork', step: -1, parents: {} };

    await checkpointer.put(
      {
        configurable: {
          thread_id: newThreadId,
          checkpoint_ns: checkpointNs,
          ...(parentCheckpointId ? { checkpoint_id: parentCheckpointId } : {}),
        },
      },
      tuple.checkpoint,
      metadata,
    );

    if (tuple.pendingWrites && tuple.pendingWrites.length > 0) {
      const byTask = new Map<string, PendingWrite[]>();
      for (const [taskId, channel, value] of tuple.pendingWrites) {
        const writes = byTask.get(taskId) ?? [];
        writes.push([channel, value]);
        byTask.set(taskId, writes);
      }
      for (const [taskId, writes] of byTask) {
        await checkpointer.putWrites(
          {
            configurable: {
              thread_id: newThreadId,
              checkpoint_ns: checkpointNs,
              checkpoint_id: tuple.checkpoint.id,
            },
          },
          writes,
          taskId,
        );
      }
    }
  }
}
