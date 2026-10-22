import type { Metric } from '../metric.js';

const EPOCH_FLOOR = '1970-01-01';
// Joins the grouping key so a model/provider name containing "(" or ")"
// can never cause two distinct pairs to collide — the display label is
// only ever formatted from the already-grouped entries, never used as the
// key itself.
const KEY_SEP = '\u0000';

export const usageByModelTokensMetric: Metric = {
  id: 'usage-by-model-tokens',
  label: 'Token Usage by Model',
  displayType: 'pie-graph',
  async resolve({ usageStore }) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = usageStore.queryUsage({ from: EPOCH_FLOOR, to: today });

    const totals = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.model}${KEY_SEP}${row.provider}`;
      const tokens = row.inputTokens + row.outputTokens;
      totals.set(key, (totals.get(key) ?? 0) + tokens);
    }

    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    return {
      displayType: 'pie-graph',
      labels: sorted.map(([key]) => {
        const [model, provider] = key.split(KEY_SEP);
        return `${model} (${provider})`;
      }),
      values: sorted.map(([, total]) => total),
    };
  },
};
