import type { Metric } from '../metric.js';

export const usageByToolMetric: Metric = {
  id: 'usage-by-tool',
  label: 'Tool Usage',
  displayType: 'pie-graph',
  async resolve({ observabilityStore }) {
    const rows = observabilityStore.queryToolCallStats();
    const sorted = [...rows].sort((a, b) => b.total - a.total);

    return {
      displayType: 'pie-graph',
      labels: sorted.map((r) => r.name),
      values: sorted.map((r) => r.total),
      valueFormat: 'compact',
    };
  },
};
