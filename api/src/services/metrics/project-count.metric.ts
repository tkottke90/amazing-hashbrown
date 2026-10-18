import type { Metric } from '../metric.js';

export const projectCountMetric: Metric = {
  id: 'project-count',
  label: 'Project Count',
  displayType: 'big-number',
  async resolve({ workspaceStore }) {
    return {
      displayType: 'big-number',
      value: workspaceStore.listProjects().length,
      unit: 'projects',
    };
  },
};
