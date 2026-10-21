import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore } from '@tkottke90/observability';
import type { Workspace, WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { workspaceCountMetric } from './workspace-count.metric.js';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Workspace',
    description: null,
    goal: null,
    location: '/tmp/ws',
    remoteUrl: null,
    javascript: false,
    python: false,
    git: false,
    wikiId: null,
    systemPrompt: null,
    threadId: null,
    summaryPath: null,
    lastSummarizedMessageId: null,
    autoApproveShell: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastChange: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(workspaces: Workspace[]): MetricDeps {
  return {
    workspaceStore: { listWorkspaces: () => workspaces } as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/workspace-count.metric', () => {
  it('returns the number of workspaces, labeled "workspaces" [unit]', async () => {
    const result = await workspaceCountMetric.resolve(
      makeDeps([workspace({ id: 'ws-1' }), workspace({ id: 'ws-2' }), workspace({ id: 'ws-3' })]),
    );
    expect(result).to.deep.equal({ displayType: 'big-number', value: 3, unit: 'workspaces' });
  });

  it('returns 0 when there are no workspaces [unit]', async () => {
    const result = await workspaceCountMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({ displayType: 'big-number', value: 0, unit: 'workspaces' });
  });
});
