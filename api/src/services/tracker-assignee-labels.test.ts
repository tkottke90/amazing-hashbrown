import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { TrackerRegistry } from './tracker-registry.js';
import type { Assignee, TrackerAdapter } from './tracker-adapter.js';
import type { TaskTrackerAssignment } from './workspace-store.js';
import { WorkspaceStore } from './workspace-store.js';
import {
  applyAssigneeLabelActions,
  bootTrackerAssigneeLabels,
  planAssigneeLabelActions,
} from './tracker-assignee-labels.js';

function assignment(
  assignedTo: TaskTrackerAssignment['assignedTo'],
  trackerId: string | null,
  trackerType: string | null = 'todoist',
): TaskTrackerAssignment {
  return { assignedTo, trackerType, trackerId };
}

interface LabelCall {
  id: string;
  assignee: Assignee;
}

function labellingAdapter(
  type: string,
  calls: LabelCall[],
  overrides: Partial<TrackerAdapter> = {},
): TrackerAdapter {
  return {
    type,
    displayName: type,
    icon: '',
    authSchema: [],
    canCreate: true,
    configured: true,
    resolveUrl: async () => {
      throw new Error('n/a');
    },
    getItem: async () => {
      throw new Error('n/a');
    },
    createItem: async () => {
      throw new Error('n/a');
    },
    updateState: async () => {
      throw new Error('n/a');
    },
    setAssignee: async (id, assignee) => {
      calls.push({ id, assignee });
    },
    ...overrides,
  };
}

describe('services/tracker-assignee-labels', () => {
  describe('planAssigneeLabelActions()', () => {
    it('labels the item when a new task is created already linked [unit]', () => {
      expect(planAssigneeLabelActions(null, assignment('user', 'a'))).to.deep.equal([
        { trackerType: 'todoist', trackerId: 'a', assignee: 'user' },
      ]);
    });

    it('labels the item when an existing task is linked [unit]', () => {
      expect(
        planAssigneeLabelActions(assignment('agent', null), assignment('agent', 'a')),
      ).to.deep.equal([{ trackerType: 'todoist', trackerId: 'a', assignee: 'agent' }]);
    });

    it('relabels the same item when the task is reassigned [unit]', () => {
      expect(
        planAssigneeLabelActions(assignment('user', 'a'), assignment('agent', 'a')),
      ).to.deep.equal([{ trackerType: 'todoist', trackerId: 'a', assignee: 'agent' }]);
    });

    it('clears the label when the task becomes unassigned while staying linked [unit]', () => {
      expect(
        planAssigneeLabelActions(assignment('user', 'a'), assignment(null, 'a')),
      ).to.deep.equal([{ trackerType: 'todoist', trackerId: 'a', assignee: null }]);
    });

    it("removes the old item's label on unlink, even though Unlink keeps trackerType set [unit]", () => {
      expect(
        planAssigneeLabelActions(assignment('user', 'a'), assignment('user', null)),
      ).to.deep.equal([{ trackerType: 'todoist', trackerId: 'a', assignee: null }]);
    });

    it('removes the old label before labelling the new item on relink [unit]', () => {
      expect(
        planAssigneeLabelActions(assignment('user', 'a'), assignment('user', 'b')),
      ).to.deep.equal([
        { trackerType: 'todoist', trackerId: 'a', assignee: null },
        { trackerType: 'todoist', trackerId: 'b', assignee: 'user' },
      ]);
    });

    it('treats a move to another tracker type with the same id as a relink [unit]', () => {
      expect(
        planAssigneeLabelActions(
          assignment('user', 'a', 'github'),
          assignment('user', 'a', 'todoist'),
        ),
      ).to.have.length(2);
    });

    it('does nothing for a task that was never linked [unit]', () => {
      expect(planAssigneeLabelActions(null, assignment('user', null))).to.deep.equal([]);
      expect(
        planAssigneeLabelActions(assignment('user', null), assignment('agent', null)),
      ).to.deep.equal([]);
    });
  });

  describe('applyAssigneeLabelActions()', () => {
    const action = { trackerType: 'todoist', trackerId: 'a', assignee: 'user' as const };

    it('calls setAssignee on the matching adapter [orchestration]', async () => {
      const calls: LabelCall[] = [];
      const registry = new TrackerRegistry();
      registry.register(labellingAdapter('todoist', calls));
      await applyAssigneeLabelActions([action], registry, 'task-1');
      expect(calls).to.deep.equal([{ id: 'a', assignee: 'user' }]);
    });

    it('skips an adapter that is not configured [orchestration]', async () => {
      const calls: LabelCall[] = [];
      const registry = new TrackerRegistry();
      registry.register(labellingAdapter('todoist', calls, { configured: false }));
      await applyAssigneeLabelActions([action], registry, 'task-1');
      expect(calls).to.have.length(0);
    });

    it('skips adapters without setAssignee (GitHub today) and unregistered types [orchestration]', async () => {
      const calls: LabelCall[] = [];
      const registry = new TrackerRegistry();
      registry.register(labellingAdapter('github', calls, { setAssignee: undefined }));
      await applyAssigneeLabelActions(
        [
          { ...action, trackerType: 'github' },
          { ...action, trackerType: 'missing' },
        ],
        registry,
        'task-1',
      );
      expect(calls).to.have.length(0);
    });

    it('swallows a failed label write so it can never fail the task change [orchestration]', async () => {
      const registry = new TrackerRegistry();
      registry.register(
        labellingAdapter('todoist', [], {
          setAssignee: async () => {
            throw new Error('premium-only: label limit reached');
          },
        }),
      );
      await applyAssigneeLabelActions([action], registry, 'task-1'); // must resolve
    });
  });

  describe('bootTrackerAssigneeLabels()', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('relabels the linked item after a reassignment, once the store write has returned [orchestration]', async () => {
      dir = mkdtempSync(join(tmpdir(), 'assignee-labels-test-'));
      const store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
      const calls: LabelCall[] = [];
      const registry = new TrackerRegistry();
      registry.register(labellingAdapter('todoist', calls));
      bootTrackerAssigneeLabels(store, () => registry);

      const task = store.createTask({
        title: 't',
        assignedTo: 'user',
        trackerType: 'todoist',
        trackerId: 'a',
      });
      store.patchTask(task.id, { assignedTo: 'agent' });
      expect(calls, 'label writes must be deferred past the store write').to.have.length(0);

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).to.deep.equal([
        { id: 'a', assignee: 'user' },
        { id: 'a', assignee: 'agent' },
      ]);
    });

    it('reads the registry at write time, so a token saved after boot takes effect [orchestration]', async () => {
      dir = mkdtempSync(join(tmpdir(), 'assignee-labels-test-'));
      const store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
      const calls: LabelCall[] = [];
      let registry = new TrackerRegistry(); // nothing registered at boot
      bootTrackerAssigneeLabels(store, () => registry);

      registry = new TrackerRegistry(); // simulates reloadTrackerRegistry()
      registry.register(labellingAdapter('todoist', calls));
      store.createTask({ title: 't', assignedTo: 'user', trackerType: 'todoist', trackerId: 'a' });

      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).to.deep.equal([{ id: 'a', assignee: 'user' }]);
    });
  });
});
