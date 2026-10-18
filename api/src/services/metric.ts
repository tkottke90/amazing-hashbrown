import type { ResolvedMetricValue } from '@tkottke90/amazing-hashbrown-widgets/types';
import type { WorkspaceStore } from './workspace-store.js';
import type { CostStore } from '@tkottke90/observability';

/**
 * What a Metric resolver needs to compute its value. Built fresh per GET by
 * `dashboards.handlers.ts` from the already-booted singleton stores plus the
 * current `env.updates.checkForUpdates` flag — never closed over at
 * registration time, so a settings change takes effect on the very next
 * dashboard load with no reload step (unlike `TrackerRegistry`).
 */
export interface MetricDeps {
  workspaceStore: WorkspaceStore;
  usageStore: CostStore;
  checkForUpdates: boolean;
  /** Injected only by `version-info`'s own tests; production always uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * A System Widget Metric (see GLOSSARY.md). `id` is the only thing a
 * System Widget's file ever persists (as its `metric` frontmatter field);
 * everything else here exists only in this process's Metric Registry.
 */
export interface Metric {
  id: string;
  /** Shown in the drawer's Metric picker. */
  label: string;
  /** The shape `resolve()` returns — must match one of `ResolvedMetricValue`'s members. */
  displayType: ResolvedMetricValue['displayType'];
  resolve(deps: MetricDeps): Promise<ResolvedMetricValue>;
}
