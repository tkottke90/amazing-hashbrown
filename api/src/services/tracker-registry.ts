import { createRequire } from 'node:module';
import { logger } from '../config/logger.js';
import type { TrackerAdapter } from './tracker-adapter.js';
import { createGithubTrackerAdapter } from '../adapters/tracker-github.js';
import { env } from '../config/env.js';

// ESM has no ambient `require` — this project is "type": "module" — so a
// CommonJS-style `require(pkg)` (per the plugin-loading spec) needs an
// explicit require shim scoped to this module's URL.
const require = createRequire(import.meta.url);

export class TrackerRegistry {
  private adapters: Map<string, TrackerAdapter> = new Map();

  register(adapter: TrackerAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: string): TrackerAdapter | undefined {
    return this.adapters.get(type);
  }

  list(): TrackerAdapter[] {
    return [...this.adapters.values()];
  }
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

let _registry: TrackerRegistry | null = null;

export function bootTrackerRegistry(): void {
  const registry = new TrackerRegistry();

  registry.register(createGithubTrackerAdapter(env.workspaces.tasks?.trackers?.github?.token));

  const pluginList = (process.env['TRACKER_PLUGINS'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  for (const pkg of pluginList) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const adapter = require(pkg) as TrackerAdapter;
      registry.register(adapter);
      logger.info('Tracker plugin registered', { pkg, type: adapter.type });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Tracker plugin failed to load', { pkg, err: message });
    }
  }

  _registry = registry;
  logger.info('Tracker registry booted', { adapters: registry.list().map((a) => a.type) });
}

export function getTrackerRegistry(): TrackerRegistry {
  if (!_registry) throw new Error('Tracker registry not initialised — call bootTrackerRegistry() first');
  return _registry;
}
