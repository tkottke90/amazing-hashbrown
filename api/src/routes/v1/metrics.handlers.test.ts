import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CostStore } from '@tkottke90/observability';
import type { WorkspaceStore } from '../../services/workspace-store.js';
import type { Metric, MetricDeps } from '../../services/metric.js';
import { listMetricsHandler, previewMetricHandler, type MetricsDeps } from './metrics.handlers.js';

function makeMetricDeps(): MetricDeps {
  return {
    workspaceStore: {} as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

function makeDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    listMetrics: () => [],
    getMetric: () => undefined,
    buildMetricDeps: makeMetricDeps,
    ...overrides,
  };
}

describe('routes/v1/metrics.handlers', () => {
  describe('listMetricsHandler()', () => {
    it('returns the catalog with only id/label/displayType, stripping resolve [unit]', () => {
      const fakeMetric: Metric = {
        id: 'workspace-count',
        label: 'Workspace Count',
        displayType: 'big-number',
        async resolve() {
          return { displayType: 'big-number', value: 1 };
        },
      };
      const result = listMetricsHandler(makeDeps({ listMetrics: () => [fakeMetric] }));

      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal([
          { id: 'workspace-count', label: 'Workspace Count', displayType: 'big-number' },
        ]);
        expect(result.data[0]).to.not.have.property('resolve');
      }
    });

    it('returns an empty array when no metrics are registered [unit]', () => {
      const result = listMetricsHandler(makeDeps({ listMetrics: () => [] }));
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal([]);
    });
  });

  describe('previewMetricHandler()', () => {
    it('returns 404 for an unknown metric id [unit]', async () => {
      const result = await previewMetricHandler(
        'does-not-exist',
        makeDeps({ getMetric: () => undefined }),
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(404);
        expect(result.error).to.include('does-not-exist');
      }
    });

    it('resolves the metric using the deps built from buildMetricDeps [orchestration]', async () => {
      const builtDeps = makeMetricDeps();
      let receivedDeps: MetricDeps | undefined;
      const fakeMetric: Metric = {
        id: 'workspace-count',
        label: 'Workspace Count',
        displayType: 'big-number',
        async resolve(deps) {
          receivedDeps = deps;
          return { displayType: 'big-number', value: 7, unit: 'workspaces' };
        },
      };

      const result = await previewMetricHandler(
        'workspace-count',
        makeDeps({ getMetric: () => fakeMetric, buildMetricDeps: () => builtDeps }),
      );

      expect(result.ok).to.equal(true);
      expect(receivedDeps).to.equal(builtDeps);
    });

    it("returns the resolver's ResolvedMetricValue unchanged on success [unit]", async () => {
      const fakeMetric: Metric = {
        id: 'workspace-count',
        label: 'Workspace Count',
        displayType: 'big-number',
        async resolve() {
          return { displayType: 'big-number', value: 7, unit: 'workspaces' };
        },
      };

      const result = await previewMetricHandler(
        'workspace-count',
        makeDeps({ getMetric: () => fakeMetric }),
      );

      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal({
          displayType: 'big-number',
          value: 7,
          unit: 'workspaces',
        });
      }
    });
  });
});
