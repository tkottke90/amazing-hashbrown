import { getMetric, listMetrics } from '../../services/metric-registry.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getUsageStore } from '../../services/usage.js';
import { env } from '../../config/env.js';
import type { MetricDeps, Metric } from '../../services/metric.js';
import type { ResolvedMetricValue } from '@tkottke90/amazing-hashbrown-widgets/types';

// ---- HandlerResult (mirrors dashboards.handlers.ts) ------------------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

// ---- Dependencies (injectable for tests) -----------------------------------------

export interface MetricsDeps {
  listMetrics: typeof listMetrics;
  getMetric: typeof getMetric;
  buildMetricDeps: () => MetricDeps;
}

function buildDefaultMetricDeps(): MetricDeps {
  return {
    workspaceStore: getWorkspaceStore(),
    usageStore: getUsageStore(),
    checkForUpdates: env.updates.checkForUpdates,
  };
}

const defaultDeps: MetricsDeps = {
  listMetrics,
  getMetric,
  buildMetricDeps: buildDefaultMetricDeps,
};

export interface MetricCatalogEntry {
  id: string;
  label: string;
  displayType: Metric['displayType'];
}

// ---- Handlers ----------------------------------------------------------------------

/**
 * The fixed catalog a System Widget's Metric picker (ADR-0013) chooses
 * from — never the resolved values themselves, only what's available.
 */
export function listMetricsHandler(
  deps: MetricsDeps = defaultDeps,
): HandlerResult<MetricCatalogEntry[]> {
  const catalog = deps
    .listMetrics()
    .map(({ id, label, displayType }) => ({ id, label, displayType }));
  return ok(catalog);
}

/**
 * Resolves one metric on demand — used only by the drawer's live preview
 * before save (ADR-0013); the result is never persisted anywhere.
 */
export async function previewMetricHandler(
  id: string,
  deps: MetricsDeps = defaultDeps,
): Promise<HandlerResult<ResolvedMetricValue>> {
  const metric = deps.getMetric(id);
  if (!metric) return notFound(`Unknown metric id "${id}".`);
  const resolved = await metric.resolve(deps.buildMetricDeps());
  return ok(resolved);
}
