import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore, ObservabilityStore } from '@tkottke90/observability';
import type { TaskCompletionStats, WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { avgRunsToCompleteMetric } from './avg-runs-to-complete.metric.js';

function makeDeps(stats: TaskCompletionStats): MetricDeps {
  return {
    workspaceStore: { taskCompletionStats: () => stats } as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    observabilityStore: {} as unknown as ObservabilityStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/avg-runs-to-complete.metric', () => {
  it('returns the average runs-to-complete, labeled "runs" [unit]', async () => {
    const result = await avgRunsToCompleteMetric.resolve(
      makeDeps({
        avgRunsToComplete: 3.5,
        completedTaskCount: 2,
        nonCompletionRate: null,
        terminalTaskCount: 0,
      }),
    );
    expect(result).to.deep.equal({ displayType: 'big-number', value: 3.5, unit: 'runs' });
  });

  it('returns 0 when no task has ever reached done [unit]', async () => {
    const result = await avgRunsToCompleteMetric.resolve(
      makeDeps({
        avgRunsToComplete: null,
        completedTaskCount: 0,
        nonCompletionRate: null,
        terminalTaskCount: 0,
      }),
    );
    expect(result).to.deep.equal({ displayType: 'big-number', value: 0, unit: 'runs' });
  });
});
