import type { Metric } from '../metric.js';

export const workspaceCountMetric: Metric = {
  id: 'workspace-count',
  label: 'Workspace Count',
  displayType: 'big-number',
  async resolve({ workspaceStore }) {
    return {
      displayType: 'big-number',
      value: workspaceStore.listWorkspaces().length,
      unit: 'workspaces',
    };
  },
};
