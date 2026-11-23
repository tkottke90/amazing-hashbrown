import type { Metric } from '../metric.js';

export const failureRateByToolMetric: Metric = {
  id: 'failure-rate-by-tool',
  label: 'Tool Failure Rate',
  displayType: 'markdown',
  async resolve({ observabilityStore }) {
    const rows = observabilityStore.queryToolCallStats();
    if (rows.length === 0) {
      return { displayType: 'markdown', content: '_No tool calls recorded yet._' };
    }

    const sorted = [...rows].sort((a, b) => {
      const rateDiff = b.failed / b.total - a.failed / a.total;
      return rateDiff !== 0 ? rateDiff : b.total - a.total;
    });

    const lines = sorted.map((r) => {
      const pct = Math.round((r.failed / r.total) * 100);
      return `| ${r.name} | ${r.total} | ${r.failed} | ${pct}% |`;
    });

    const content = [
      '| Tool | Calls | Failures | Failure Rate |',
      '| ---- | ----- | -------- | ------------ |',
      ...lines,
    ].join('\n');

    return { displayType: 'markdown', content };
  },
};
