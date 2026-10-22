import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { UsageRow, CostStore } from '@tkottke90/observability';
import type { WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { totalInferenceSpendMetric } from './total-inference-spend.metric.js';

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    date: '2026-01-01',
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0,
    ...overrides,
  };
}

function makeDeps(rows: UsageRow[]): MetricDeps {
  return {
    usageStore: { queryUsage: () => rows } as unknown as CostStore,
    workspaceStore: {} as unknown as WorkspaceStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/total-inference-spend.metric', () => {
  it('sums estimatedCost across every row, rounded to the nearest cent [unit]', async () => {
    const rows = [row({ estimatedCost: 12.345 }), row({ estimatedCost: 0.005 })];
    const result = await totalInferenceSpendMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({ displayType: 'big-number', value: 12.35, unit: 'USD' });
  });

  it('returns 0 when there are no usage rows [unit]', async () => {
    const result = await totalInferenceSpendMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({ displayType: 'big-number', value: 0, unit: 'USD' });
  });

  it('calls usageStore.queryUsage with the epoch floor through today [unit]', async () => {
    let calledWith: { from: string; to: string } | undefined;
    const deps: MetricDeps = {
      usageStore: {
        queryUsage: (range: { from: string; to: string }) => {
          calledWith = range;
          return [];
        },
      } as unknown as CostStore,
      workspaceStore: {} as unknown as WorkspaceStore,
      checkForUpdates: false,
    };

    await totalInferenceSpendMetric.resolve(deps);

    expect(calledWith?.from).to.equal('1970-01-01');
    expect(calledWith?.to).to.equal(new Date().toISOString().slice(0, 10));
  });
});
