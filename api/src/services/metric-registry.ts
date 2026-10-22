import { logger } from '../config/logger.js';
import type { DashboardWidget } from '@tkottke90/amazing-hashbrown-widgets/types';
import type { Metric, MetricDeps } from './metric.js';
import { workspaceCountMetric } from './metrics/workspace-count.metric.js';
import { projectCountMetric } from './metrics/project-count.metric.js';
import { totalInferenceSpendMetric } from './metrics/total-inference-spend.metric.js';
import { workspaceListMetric } from './metrics/workspace-list.metric.js';
import { versionInfoMetric } from './metrics/version-info.metric.js';
import { usageByProviderTokensMetric } from './metrics/usage-by-provider-tokens.metric.js';
import { usageByModelTokensMetric } from './metrics/usage-by-model-tokens.metric.js';

const metrics = new Map<string, Metric>();

export function registerMetric(metric: Metric): void {
  metrics.set(metric.id, metric);
}

export function getMetric(id: string): Metric | undefined {
  return metrics.get(id);
}

export function listMetrics(): Metric[] {
  return [...metrics.values()];
}

// Populated at module load — unlike TrackerRegistry, nothing here is
// reconfigured by settings at registration time (each resolver reads live
// config, e.g. env.updates.checkForUpdates, at call time instead), so
// there's no boot/reload lifecycle to wire up.
registerMetric(workspaceCountMetric);
registerMetric(projectCountMetric);
registerMetric(totalInferenceSpendMetric);
registerMetric(workspaceListMetric);
registerMetric(versionInfoMetric);
registerMetric(usageByProviderTokensMetric);
registerMetric(usageByModelTokensMetric);

/**
 * Resolves a `source: 'system'` widget's live value in place (ADR-0011) —
 * a no-op for any other widget type. An unknown `metric` id or a resolver
 * that throws both log a warning and leave `resolved` undefined rather than
 * failing the whole dashboard GET; one bad widget never breaks the others.
 */
export async function resolveSystemWidget(
  widget: DashboardWidget,
  deps: MetricDeps,
): Promise<DashboardWidget> {
  if (widget.type !== 'system') return widget;

  const metric = getMetric(widget.metric);
  if (!metric) {
    logger.warn('Unknown metric id on system widget', { id: widget.id, metric: widget.metric });
    return widget;
  }

  try {
    const resolved = await metric.resolve(deps);
    return { ...widget, resolved };
  } catch (err) {
    logger.warn('Metric resolution failed', {
      id: widget.id,
      metric: widget.metric,
      err: err instanceof Error ? err.message : String(err),
    });
    return widget;
  }
}
