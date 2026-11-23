import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore, ObservabilityStore, ToolCallStatsRow } from '@tkottke90/observability';
import type { WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { failureRateByToolMetric } from './failure-rate-by-tool.metric.js';

function makeDeps(rows: ToolCallStatsRow[]): MetricDeps {
  return {
    observabilityStore: { queryToolCallStats: () => rows } as unknown as ObservabilityStore,
    workspaceStore: {} as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/failure-rate-by-tool.metric', () => {
  it('returns a markdown placeholder when there are no tool-call spans [unit]', async () => {
    const result = await failureRateByToolMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({
      displayType: 'markdown',
      content: '_No tool calls recorded yet._',
    });
  });

  it('renders every tool as a table row, including 0% for a tool with no failures [unit]', async () => {
    const result = await failureRateByToolMetric.resolve(
      makeDeps([{ name: 'read_file', total: 4, failed: 0 }]),
    );
    expect(result).to.deep.equal({
      displayType: 'markdown',
      content: [
        '| Tool | Calls | Failures | Failure Rate |',
        '| ---- | ----- | -------- | ------------ |',
        '| read_file | 4 | 0 | 0% |',
      ].join('\n'),
    });
  });

  it('rounds the failure rate to the nearest whole percent [unit]', async () => {
    const result = await failureRateByToolMetric.resolve(
      makeDeps([{ name: 'flaky_tool', total: 3, failed: 2 }]),
    );
    expect(result.displayType).to.equal('markdown');
    expect(result).to.have.property(
      'content',
      [
        '| Tool | Calls | Failures | Failure Rate |',
        '| ---- | ----- | -------- | ------------ |',
        '| flaky_tool | 3 | 2 | 67% |',
      ].join('\n'),
    );
  });

  it('sorts descending by failure rate, breaking ties by total calls descending [unit]', async () => {
    const rows: ToolCallStatsRow[] = [
      { name: 'low-rate-high-volume', total: 100, failed: 10 }, // 10%
      { name: 'high-rate-low-volume', total: 4, failed: 2 }, // 50%
      { name: 'same-rate-more-calls', total: 10, failed: 5 }, // 50%, tiebreak winner
    ];
    const result = await failureRateByToolMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'markdown',
      content: [
        '| Tool | Calls | Failures | Failure Rate |',
        '| ---- | ----- | -------- | ------------ |',
        '| same-rate-more-calls | 10 | 5 | 50% |',
        '| high-rate-low-volume | 4 | 2 | 50% |',
        '| low-rate-high-volume | 100 | 10 | 10% |',
      ].join('\n'),
    });
  });
});
