import type { Board, Task } from '@/services/tasks-api';

// A task as the tasks API returns it — with its Kanban board projection.
// Tests override the fields (and board) the scenario is about.
export function boardTask(overrides: Partial<Task> = {}, board: Partial<Board> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: 'Deploy Infisical',
    description: null,
    outcome: null,
    status: 'pending',
    assignedTo: 'agent',
    dueAt: null,
    expiresAt: null,
    triggerType: 'manual',
    triggerConfig: null,
    trackerType: null,
    trackerId: null,
    plan: null,
    blockedReason: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
    board: { lane: 'backlog', moves: [], ...board },
  };
}
