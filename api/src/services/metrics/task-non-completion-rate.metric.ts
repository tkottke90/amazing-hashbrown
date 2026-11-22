import type { Metric } from '../metric.js';

export const taskNonCompletionRateMetric: Metric = {
  id: 'task-non-completion-rate',
  label: 'Task Non-Completion Rate',
  displayType: 'big-number',
  async resolve({ workspaceStore }) {
    const { nonCompletionRate } = workspaceStore.taskCompletionStats();
    return {
      displayType: 'big-number',
      value: Math.round((nonCompletionRate ?? 0) * 100),
      unit: '%',
    };
  },
};
