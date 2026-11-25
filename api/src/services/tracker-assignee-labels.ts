import { logger } from '../config/logger.js';
import type { Assignee } from './tracker-adapter.js';
import type { TrackerRegistry } from './tracker-registry.js';
import type {
  TaskTrackerAssignment,
  TaskTrackerAssignmentChange,
  WorkspaceStore,
} from './workspace-store.js';

// Keeps each linked tracker item's Assignee Label (GLOSSARY.md) in step with
// its hashbrown task: written when a link is made, updated whenever the
// task is reassigned, and removed from an item once its link ends. Label
// writes are best-effort — a failure is logged and never affects the task
// write that triggered it.

export interface AssigneeLabelAction {
  trackerType: string;
  trackerId: string;
  assignee: Assignee;
}

// A task is linked only when it has a tracker item id — the drawer's Unlink
// leaves trackerType set and clears just trackerId.
function linkOf(a: TaskTrackerAssignment | null): { type: string; id: string } | null {
  return a?.trackerType && a.trackerId ? { type: a.trackerType, id: a.trackerId } : null;
}

export function planAssigneeLabelActions(
  before: TaskTrackerAssignment | null,
  after: TaskTrackerAssignment,
): AssigneeLabelAction[] {
  const was = linkOf(before);
  const now = linkOf(after);
  const sameItem = Boolean(was && now && was.type === now.type && was.id === now.id);
  const actions: AssigneeLabelAction[] = [];

  if (was && !sameItem) {
    actions.push({ trackerType: was.type, trackerId: was.id, assignee: null });
  }
  if (now && (!sameItem || before?.assignedTo !== after.assignedTo)) {
    actions.push({ trackerType: now.type, trackerId: now.id, assignee: after.assignedTo });
  }
  return actions;
}

// Exposed for tests; production wiring is bootTrackerAssigneeLabels().
export function applyAssigneeLabelActions(
  actions: AssigneeLabelAction[],
  registry: TrackerRegistry,
  taskId: string,
): Promise<void> {
  const writes = actions.map(async (action) => {
    const adapter = registry.get(action.trackerType);
    if (!adapter || !adapter.configured || !adapter.setAssignee) return;
    try {
      await adapter.setAssignee(action.trackerId, action.assignee);
    } catch (err) {
      logger.warn('Assignee label update failed', {
        taskId,
        trackerType: action.trackerType,
        trackerId: action.trackerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return Promise.all(writes).then(() => undefined);
}

// `getRegistry` rather than a registry instance: the registry is rebuilt on
// every settings save, and a captured instance would keep a stale token.
export function bootTrackerAssigneeLabels(
  store: WorkspaceStore,
  getRegistry: () => TrackerRegistry,
): () => void {
  return store.onTaskTrackerAssignmentChanged((change: TaskTrackerAssignmentChange) => {
    const actions = planAssigneeLabelActions(change.before, change.after);
    if (actions.length === 0) return;
    // Deferred so the store write (possibly inside a transaction) finishes
    // before any network call starts.
    setImmediate(() => {
      void applyAssigneeLabelActions(actions, getRegistry(), change.taskId);
    });
  });
}
