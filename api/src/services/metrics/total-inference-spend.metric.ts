import type { Metric } from '../metric.js';

// SQLite has no stored rows before the app existed; walking from an epoch
// floor through today gets every row `v_usage` has without needing a
// separate "all time" query shape. Same per-row reduce `usage.route.ts`
// already uses for its totals — `v_usage` has no SQL `SUM`-to-one-row query
// of its own (see cost-store.ts), and isn't worth adding purely for this.
const EPOCH_FLOOR = '1970-01-01';

export const totalInferenceSpendMetric: Metric = {
  id: 'total-inference-spend',
  label: 'Total Inference Spend',
  displayType: 'big-number',
  async resolve({ usageStore }) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = usageStore.queryUsage({ from: EPOCH_FLOOR, to: today });
    const total = rows.reduce((sum, row) => sum + row.estimatedCost, 0);
    return {
      displayType: 'big-number',
      value: Math.round(total * 100) / 100,
      unit: 'USD',
    };
  },
};
