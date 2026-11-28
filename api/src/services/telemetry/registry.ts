import { Registry } from '@prometheus-io/client';
import type { CostStore, ObservabilityStore } from '@tkottke90/observability';
import { registerLlmUsageCollector } from './llm-usage.collector.js';
import { registerToolCallsCollector } from './tool-calls.collector.js';
import { registerLoopGuardCollector } from './loop-guard.collector.js';
import { registerTaskRunsCollector } from './task-runs.collector.js';
import type { ThreadStore } from '../thread-store.js';
import type { WorkspaceStore } from '../workspace-store.js';

export interface TelemetryRegistryDeps {
  getUsageStore: () => CostStore;
  getObservabilityStore: () => ObservabilityStore;
  getThreadStore: () => ThreadStore;
  getWorkspaceStore: () => WorkspaceStore;
}

/**
 * Builds the Telemetry Endpoint's own Registry — never the library's global
 * one, so nothing else can leak onto the endpoint — with each collector
 * composed in. Stores are passed as getters because they're booted after
 * module load. A new collector (e.g. skill usage, #451) is one more
 * `register*Collector` call here.
 */
export function createTelemetryRegistry(deps: TelemetryRegistryDeps): Registry {
  const registry = new Registry();
  registerLlmUsageCollector(registry, deps.getUsageStore);
  registerToolCallsCollector(registry, deps.getObservabilityStore);
  registerLoopGuardCollector(registry, deps.getThreadStore, deps.getWorkspaceStore);
  registerTaskRunsCollector(registry, deps.getWorkspaceStore);
  return registry;
}
