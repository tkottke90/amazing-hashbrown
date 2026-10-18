import type { Metric } from '../metric.js';

export const workspaceListMetric: Metric = {
  id: 'workspace-list',
  label: 'Workspace List',
  displayType: 'markdown',
  async resolve({ workspaceStore }) {
    const workspaces = workspaceStore.listWorkspaces();
    if (workspaces.length === 0) {
      return { displayType: 'markdown', content: '_No workspaces yet._' };
    }

    // One query to tag every workspace as Workspace/Project, instead of an
    // N+1 getProject() lookup per row.
    const projectIds = new Set(workspaceStore.listProjects().map((p) => p.id));
    const lines = workspaces.map((w) => {
      const kind = projectIds.has(w.id) ? 'Project' : 'Workspace';
      return `- [${w.name}](/workspaces/${w.id}) — ${kind}`;
    });
    return { displayType: 'markdown', content: lines.join('\n') };
  },
};
