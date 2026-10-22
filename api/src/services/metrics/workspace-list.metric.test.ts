import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore } from '@tkottke90/observability';
import type { Workspace, Project, WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { workspaceListMetric } from './workspace-list.metric.js';

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

function makeDeps(
  workspaces: Workspace[],
  projects: Array<Workspace & { project: Project }> = [],
): MetricDeps {
  return {
    workspaceStore: {
      listWorkspaces: () => workspaces,
      listProjects: () => projects,
    } as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/workspace-list.metric', () => {
  it('returns a placeholder when there are no workspaces [unit]', async () => {
    const result = await workspaceListMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({ displayType: 'markdown', content: '_No workspaces yet._' });
  });

  it('tags a plain workspace as "Workspace" and a workspace with a project as "Project" [unit]', async () => {
    const plain = workspace({ id: 'ws-1', name: 'Plain Workspace' });
    const withProject = workspace({ id: 'ws-2', name: 'Project Workspace' });
    const result = await workspaceListMetric.resolve(
      makeDeps([plain, withProject], [{ ...withProject, project: project({ id: 'proj-1' }) }]),
    );
    expect(result).to.deep.equal({
      displayType: 'markdown',
      content: [
        '- [Plain Workspace](/workspaces/ws-1) — Workspace',
        '- [Project Workspace](/workspaces/ws-2) — Project',
      ].join('\n'),
    });
  });
});
