import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore } from '@tkottke90/observability';
import type { TaskCompletionStats, WorkspaceStore } from '../workspace-store.js';
import type { MetricDeps } from '../metric.js';
import { taskNonCompletionRateMetric } from './task-non-completion-rate.metric.js';

function makeDeps(stats: TaskCompletionStats): MetricDeps {
  return {
    workspaceStore: { taskCompletionStats: () => stats } as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

describe('services/metrics/task-non-completion-rate.metric', () => {
  it('returns the non-completion rate as a rounded percentage [unit]', async () => {
    const result = await taskNonCompletionRateMetric.resolve(
      makeDeps({
        avgRunsToComplete: null,
        completedTaskCount: 0,
        nonCompletionRate: 2 / 3,
        terminalTaskCount: 3,
      }),
    );
    expect(result).to.deep.equal({ displayType: 'big-number', value: 67, unit: '%' });
  });

  it('returns 0% when no task has ever reached a terminal status [unit]', async () => {
    const result = await taskNonCompletionRateMetric.resolve(
      makeDeps({
        avgRunsToComplete: null,
        completedTaskCount: 0,
        nonCompletionRate: null,
        terminalTaskCount: 0,
      }),
    );
    expect(result).to.deep.equal({ displayType: 'big-number', value: 0, unit: '%' });
  });
});
