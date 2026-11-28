import type { Registry } from '@prometheus-io/client';
import { env } from '../config/env.js';
import { getUsageStore } from '../services/usage.js';
import { getObservabilityStore } from '../services/observability.js';
import { getThreadStore } from '../services/thread-store.js';
import { getWorkspaceStore } from '../services/workspace-store.js';
import { createTelemetryRegistry } from '../services/telemetry/registry.js';

export interface HandlerFailure {
  ok: false;
  status: 404;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

export interface ScrapeDeps {
  isEnabled: () => boolean;
  getRegistry: () => Registry;
}

export interface ScrapeResult {
  contentType: string;
  body: string;
}

let _registry: Registry | null = null;

const defaultDeps: ScrapeDeps = {
  // Read per request so toggling `telemetry.enabled` needs no restart.
  isEnabled: () => env.telemetry.enabled,
  getRegistry: () => {
    _registry ??= createTelemetryRegistry({
      getUsageStore,
      getObservabilityStore,
      getThreadStore,
      getWorkspaceStore,
    });
    return _registry;
  },
};

/**
 * `GET /metrics`. While Telemetry is disabled this answers 404, as if the
 * route did not exist, without touching the registry or any store.
 */
export async function scrapeTelemetryHandler(
  deps: ScrapeDeps = defaultDeps,
): Promise<HandlerResult<ScrapeResult>> {
  if (!deps.isEnabled()) {
    return { ok: false, status: 404, error: 'Not found' };
  }
  const registry = deps.getRegistry();
  return { ok: true, data: { contentType: registry.contentType, body: await registry.metrics() } };
}
