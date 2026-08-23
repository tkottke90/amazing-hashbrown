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

// Builds a fresh registry from current config — used both at boot and to
// pick up a token saved through Settings afterward. `createGithubTrackerAdapter`
// closes over whatever token it's given at construction time (`canCreate` is
// computed once, from `Boolean(token)`), so without re-running this the
// adapter would keep using the token that existed when the process started
// — a token saved later via `PATCH /settings/trackers` would silently never
// take effect until the next server restart.
function buildTrackerRegistry(): TrackerRegistry {
  const registry = new TrackerRegistry();

  registry.register(createGithubTrackerAdapter(env.workspaces.tasks?.trackers?.github?.token));

  const pluginList = (process.env['TRACKER_PLUGINS'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const pkg of pluginList) {
    try {
      const adapter = require(pkg) as TrackerAdapter;
      registry.register(adapter);
      logger.info('Tracker plugin registered', { pkg, type: adapter.type });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Tracker plugin failed to load', { pkg, err: message });
    }
  }

  return registry;
}

export function bootTrackerRegistry(): void {
  _registry = buildTrackerRegistry();
  logger.info('Tracker registry booted', { adapters: _registry.list().map((a) => a.type) });
}

// Called after every settings PATCH (see settings.route.ts), same as
// invalidateChatAgent()/seedProviderCosts() — cheap to run unconditionally,
// and the only way a saved trackers.github.token ever reaches the adapter
// without a restart.
export function reloadTrackerRegistry(): void {
  _registry = buildTrackerRegistry();
  logger.info('Tracker registry reloaded', { adapters: _registry.list().map((a) => a.type) });
}

export function getTrackerRegistry(): TrackerRegistry {
  if (!_registry)
    throw new Error('Tracker registry not initialised — call bootTrackerRegistry() first');
  return _registry;
}
