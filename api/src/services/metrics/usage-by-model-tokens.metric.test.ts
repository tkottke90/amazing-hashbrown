import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { UsageRow, CostStore } from '@tkottke90/observability';
import type { WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { usageByModelTokensMetric } from './usage-by-model-tokens.metric.js';

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

describe('services/metrics/usage-by-model-tokens.metric', () => {
  it('returns displayType "pie-graph" [unit]', async () => {
    const result = await usageByModelTokensMetric.resolve(makeDeps([row()]));
    expect(result.displayType).to.equal('pie-graph');
  });

  it('sums inputTokens + outputTokens per model+provider pair [unit]', async () => {
    const rows = [
      row({ model: 'claude-sonnet', provider: 'anthropic', inputTokens: 100, outputTokens: 50 }),
      row({ model: 'claude-sonnet', provider: 'anthropic', inputTokens: 20, outputTokens: 5 }),
    ];
    const result = await usageByModelTokensMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['claude-sonnet (anthropic)'],
      values: [175],
    });
  });

  it('labels each slice "<model> (<provider>)" [unit]', async () => {
    const result = await usageByModelTokensMetric.resolve(
      makeDeps([row({ model: 'gpt-4o', provider: 'openai', inputTokens: 10, outputTokens: 10 })]),
    );
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['gpt-4o (openai)'],
      values: [20],
    });
  });

  it('keeps the same model name distinct when it appears under two different providers [unit]', async () => {
    const rows = [
      row({ model: 'llama3', provider: 'ollama', inputTokens: 100, outputTokens: 0 }),
      row({ model: 'llama3', provider: 'openrouter', inputTokens: 10, outputTokens: 0 }),
    ];
    const result = await usageByModelTokensMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['llama3 (ollama)', 'llama3 (openrouter)'],
      values: [100, 10],
    });
  });

  it('sorts model+provider pairs descending by total tokens [unit]', async () => {
    const rows = [
      row({ model: 'small', provider: 'p', inputTokens: 1, outputTokens: 1 }),
      row({ model: 'big', provider: 'p', inputTokens: 1000, outputTokens: 0 }),
    ];
    const result = await usageByModelTokensMetric.resolve(makeDeps(rows));
    expect(result).to.deep.equal({
      displayType: 'pie-graph',
      labels: ['big (p)', 'small (p)'],
      values: [1000, 2],
    });
  });

  it('returns empty labels/values when usageStore has no rows [unit]', async () => {
    const result = await usageByModelTokensMetric.resolve(makeDeps([]));
    expect(result).to.deep.equal({ displayType: 'pie-graph', labels: [], values: [] });
  });
});
