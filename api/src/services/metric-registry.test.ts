import { describe, it } from 'mocha';
import { expect } from 'chai';
import type {
  DashboardWidget,
  MarkdownWidget,
  SystemWidget,
  ResolvedMetricValue,
} from '@tkottke90/amazing-hashbrown-widgets/types';
import type { CostStore } from '@tkottke90/observability';
import type { WorkspaceStore } from './workspace-store.js';
import type { Metric, MetricDeps } from './metric.js';
import { registerMetric, getMetric, listMetrics, resolveSystemWidget } from './metric-registry.js';

function makeDeps(): MetricDeps {
  return {
    workspaceStore: {} as unknown as WorkspaceStore,
    usageStore: {} as unknown as CostStore,
    checkForUpdates: false,
  };
}

function markdownWidget(overrides: Partial<MarkdownWidget> = {}): MarkdownWidget {
  return {
    id: 'w1',
    type: 'markdown',
    title: 'A markdown widget',
    order: 0,
    w: 4,
    h: 3,
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
    content: 'hello',
    ...overrides,
  };
}

function systemWidget(overrides: Partial<SystemWidget> = {}): SystemWidget {
  return {
    id: 'w1',
    type: 'system',
    title: 'A system widget',
    order: 0,
    w: 4,
    h: 3,
    source: 'system',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metric: 'usage-by-provider-tokens',
    ...overrides,
  };
}

describe('services/metric-registry', () => {
  describe('registerMetric / getMetric / listMetrics', () => {
    it('getMetric returns a registered metric by id [unit]', () => {
      const fakeMetric: Metric = {
        id: '__test_metric_registry_get__',
        label: 'Test Metric',
        displayType: 'big-number',
        async resolve() {
          return { displayType: 'big-number', value: 1 };
        },
      };
      registerMetric(fakeMetric);
      expect(getMetric('__test_metric_registry_get__')).to.equal(fakeMetric);
    });

    it('getMetric returns undefined for an unknown id [unit]', () => {
      expect(getMetric('__test_metric_registry_does_not_exist__')).to.equal(undefined);
    });

    it('listMetrics includes every registered metric, including the production catalog [unit]', () => {
      const ids = listMetrics().map((m) => m.id);
      expect(ids).to.include.members([
        'workspace-count',
        'project-count',
        'total-inference-spend',
        'workspace-list',
        'version-info',
        'usage-by-provider-tokens',
        'usage-by-model-tokens',
      ]);
    });
  });

  describe('resolveSystemWidget', () => {
    it('returns a non-system widget unchanged [unit]', async () => {
      const widget: DashboardWidget = markdownWidget();
      const result = await resolveSystemWidget(widget, makeDeps());
      expect(result).to.deep.equal(widget);
    });

    it('leaves resolved undefined for an unknown metric id [unit]', async () => {
      const widget: DashboardWidget = systemWidget({ metric: '__test_metric_registry_unknown__' });
      const result = await resolveSystemWidget(widget, makeDeps());
      expect((result as SystemWidget).resolved).to.equal(undefined);
      expect(result).to.deep.equal(widget);
    });

    it('leaves resolved undefined when the metric resolver throws [unit]', async () => {
      const throwingMetric: Metric = {
        id: '__test_metric_registry_throws__',
        label: 'Throws',
        displayType: 'big-number',
        async resolve() {
          throw new Error('boom');
        },
      };
      registerMetric(throwingMetric);

      const widget: DashboardWidget = systemWidget({ metric: throwingMetric.id });
      const result = await resolveSystemWidget(widget, makeDeps());

      expect((result as SystemWidget).resolved).to.equal(undefined);
      expect(result).to.deep.equal(widget);
    });

    it('attaches resolved on successful resolution, preserving the rest of the widget [unit]', async () => {
      const fixedValue: ResolvedMetricValue = {
        displayType: 'big-number',
        value: 42,
        unit: 'things',
      };
      const successMetric: Metric = {
        id: '__test_metric_registry_success__',
        label: 'Success',
        displayType: 'big-number',
        async resolve() {
          return fixedValue;
        },
      };
      registerMetric(successMetric);

      const widget: DashboardWidget = systemWidget({
        id: 'w42',
        title: 'Succeeds',
        metric: successMetric.id,
      });
      const result = await resolveSystemWidget(widget, makeDeps());

      expect(result).to.deep.equal({ ...widget, resolved: fixedValue });
    });
  });
});
