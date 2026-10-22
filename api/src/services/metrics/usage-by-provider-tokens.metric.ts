import type { Metric } from '../metric.js';

const EPOCH_FLOOR = '1970-01-01';

export const usageByProviderTokensMetric: Metric = {
  id: 'usage-by-provider-tokens',
  label: 'Token Usage by Provider',
  displayType: 'pie-graph',
  async resolve({ usageStore }) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = usageStore.queryUsage({ from: EPOCH_FLOOR, to: today });

    const totals = new Map<string, number>();
    for (const row of rows) {
      const tokens = row.inputTokens + row.outputTokens;
      totals.set(row.provider, (totals.get(row.provider) ?? 0) + tokens);
    }

    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    return {
      displayType: 'pie-graph',
      labels: sorted.map(([provider]) => provider),
      values: sorted.map(([, total]) => total),
    };
  },
};
