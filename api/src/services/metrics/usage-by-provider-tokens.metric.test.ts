import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { UsageRow, CostStore } from '@tkottke90/observability';
import type { WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { usageByProviderTokensMetric } from './usage-by-provider-tokens.metric.js';

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

describe('services/metrics/usage-by-provider-tokens.metric', () => {
  it('returns displayType "pie-graph" [unit]', async () => {
    const result = await usageByProviderTokensMetric.resolve(makeDeps([row()]));
    expect(result.displayType).to.equal('pie-graph');
  });

  it('sums inputTokens + outputTokens per provider [unit]', async () => {
    const rows = [
      row({ provider: 'anthropic', inputTokens: 100, outputTokens: 50 }),
      row({ provider: 'anthropic', inputTokens: 20, outputTokens: 5 }),
    ];
    const result = await usageByProviderTokensMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['anthropic'],
      values: [175],
    });
  });

  it('sorts providers descending by total tokens [unit]', async () => {
    const rows = [
      row({ provider: 'small', inputTokens: 1, outputTokens: 1 }),
      row({ provider: 'big', inputTokens: 1000, outputTokens: 0 }),
      row({ provider: 'medium', inputTokens: 50, outputTokens: 0 }),
    ];
    const result = await usageByProviderTokensMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['big', 'medium', 'small'],
      values: [1000, 50, 2],
    });
  });

  it('returns empty labels/values when usageStore has no rows [unit]', async () => {
    const result = await usageByProviderTokensMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({ displayType: 'pie-graph', labels: [], values: [] });
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

    await usageByProviderTokensMetric.resolve(deps);

    expect(calledWith?.from).to.equal('1970-01-01');
    expect(calledWith?.to).to.equal(new Date().toISOString().slice(0, 10));
  });
});
