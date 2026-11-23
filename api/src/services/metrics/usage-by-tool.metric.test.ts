import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore, ObservabilityStore, ToolCallStatsRow } from '@tkottke90/observability';
import type { WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { usageByToolMetric } from './usage-by-tool.metric.js';

function makeDeps(rows: ToolCallStatsRow[]): MetricDeps {
  return {
    observabilityStore: { queryToolCallStats: () => rows } as unknown as ObservabilityStore,
    workspaceStore: {} as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/usage-by-tool.metric', () => {
  it('returns displayType "pie-graph" with compact value formatting [unit]', async () => {
    const result = await usageByToolMetric.resolve(
      makeDeps([{ name: 'read_file', total: 5, failed: 0 }]),
    );
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['read_file'],
      values: [5],
      valueFormat: 'compact',
    });
  });

  it('sorts tools descending by call count [unit]', async () => {
    const rows: ToolCallStatsRow[] = [
      { name: 'small', total: 1, failed: 0 },
      { name: 'big', total: 100, failed: 0 },
      { name: 'medium', total: 10, failed: 0 },
    ];
    const result = await usageByToolMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['big', 'medium', 'small'],
      values: [100, 10, 1],
      valueFormat: 'compact',
    });
  });

  it('returns empty labels/values when there are no tool-call spans [unit]', async () => {
    const result = await usageByToolMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: [],
      values: [],
      valueFormat: 'compact',
    });
  });
});
