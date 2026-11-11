import { randomUUID } from 'node:crypto';
import { logger, serializeError } from '../../config/logger.js';
import type { ThreadStore } from '../../services/thread-store.js';
import type { Workspace, WorkspaceStore } from '../../services/workspace-store.js';
import type { Wakeup, WakeupCancelSource, WakeupStore } from '../../services/wakeup-store.js';

// Narrowed to the one method this handler actually calls — the real
// WakeupRegistry class (whose other fields are private, so a plain test
// stub can't structurally satisfy it) and a test stub both satisfy this.
export interface WakeupCanceler {
  cancel(wakeupId: string, by: WakeupCancelSource, reason?: string): Wakeup | null;
}

// Same HandlerResult<T>/HandlerFailure shape as threads.handlers.ts — each
// handlers file in this codebase declares its own copy rather than sharing
// one (see api/AGENTS.md's testing convention).
export interface HandlerFailure {
  ok: false;
  status: 400 | 500;
  error: string;
}
export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}
function invalid(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}
function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

export interface ReplaceThreadResult {
  threadId: string;
  archivedThreadId: string;
}

export interface ReplaceThreadDeps {
  workspaceStore: WorkspaceStore;
  threadStore: ThreadStore;
  wakeupStore: WakeupStore;
  wakeupRegistry: WakeupCanceler;
  // Injected so this handler has no LLM/model-resolution concerns of its
  // own — the route composes the real maybeSummarizeWorkspace call; a test
  // can inject a stub with no provider involved at all.
  summarize: (workspace: Workspace, supersededBy: string) => Promise<void>;
}

// Replace Thread (see GLOSSARY.md "Workspace Chat Continuity Across
// Threads", ADR-0064/0065): retires a workspace's current thread for a
// fresh one, UI-triggered only, never an agent tool.
//
// Sequencing matters: step 1 is async and model-involving, so it must run
// before any SQLite transaction opens (better-sqlite3 transactions are
// synchronous only). Steps 2 (archive + rename + repoint) run as one
// transaction so a failure partway never leaves the workspace half
// migrated. Step 3 (wake-up cancellation) runs after that transaction
// commits and is best-effort — it touches an in-process timer, not just a
// DB row, and must never fail the overall operation once the migration
// has already committed.
export async function replaceThreadHandler(
  deps: ReplaceThreadDeps,
  workspace: Workspace,
): Promise<HandlerResult<ReplaceThreadResult>> {
  const oldThreadId = workspace.threadId;
  if (!oldThreadId) return invalid('Workspace has no active thread to replace.');

  // No thread row is pre-created for this id — upsertThreadOnFirstMessage
  // lazily creates it on the successor's first real message, same as any
  // new workspace-chat thread.
  const newThreadId = randomUUID();

  try {
    await deps.summarize(workspace, newThreadId);
  } catch (err) {
    logger.error('replaceThreadHandler: failed to force-summarize the current thread', {
      workspaceId: workspace.id,
      oldThreadId,
      err: serializeError(err),
    });
    return serverError(
      `Failed to summarize the current thread: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const migrated = deps.threadStore.runInTransaction((): ReplaceThreadResult | null => {
    const archived = deps.threadStore.archiveThread(oldThreadId);
    if (!archived) return null;
    deps.threadStore.renameThread(oldThreadId, `${archived.title} (replaced)`);
    const patched = deps.workspaceStore.patchWorkspace(workspace.id, {
      threadId: newThreadId,
      lastSummarizedMessageId: null,
    });
    if (!patched) return null;
    return { threadId: newThreadId, archivedThreadId: oldThreadId };
  });

  if (!migrated) {
    return serverError('Failed to archive the old thread and repoint the workspace.');
  }

  try {
    const pending = deps.wakeupStore.getPending(oldThreadId);
    if (pending) deps.wakeupRegistry.cancel(pending.id, 'thread_replaced');
  } catch (err) {
    logger.warn('replaceThreadHandler: failed to cancel pending wake-up on replaced thread', {
      oldThreadId,
      err: serializeError(err),
    });
  }

  return ok(migrated);
}
