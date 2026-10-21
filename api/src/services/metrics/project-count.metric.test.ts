import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore } from '@tkottke90/observability';
import type { Workspace, Project, WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { projectCountMetric } from './project-count.metric.js';

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

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    winCondition: 'Ship it',
    dueAt: null,
    status: 'active',
    closedAt: null,
    closeIntent: null,
    snapshotPath: null,
    closeProgress: null,
    ...overrides,
  };
}

function makeDeps(projects: Array<Workspace & { project: Project }>): MetricDeps {
  return {
    workspaceStore: { listProjects: () => projects } as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/project-count.metric', () => {
  it('returns the number of projects, labeled "projects" [unit]', async () => {
    const result = await projectCountMetric.resolve(
      makeDeps([
        { ...workspace({ id: 'ws-1' }), project: project({ id: 'proj-1' }) },
        { ...workspace({ id: 'ws-2' }), project: project({ id: 'proj-2' }) },
      ]),
    );
    expect(result).to.deep.equal({ displayType: 'big-number', value: 2, unit: 'projects' });
  });

  it('returns 0 when there are no projects [unit]', async () => {
    const result = await projectCountMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({ displayType: 'big-number', value: 0, unit: 'projects' });
  });
});
