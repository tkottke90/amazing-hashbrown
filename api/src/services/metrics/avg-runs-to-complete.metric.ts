import type { Metric } from '../metric.js';

export const avgRunsToCompleteMetric: Metric = {
  id: 'avg-runs-to-complete',
  label: 'Average Runs to Complete',
  displayType: 'big-number',
  async resolve({ workspaceStore }) {
    return {
      displayType: 'big-number',
      value: workspaceStore.taskCompletionStats().avgRunsToComplete ?? 0,
      unit: 'runs',
    };
  },
};
