import { ObservabilityStore } from '@tkottke90/observability';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let _store: ObservabilityStore | null = null;

export function bootObservability(): void {
  _store = ObservabilityStore.open(env.observability.dbPath);
  logger.info('Observability store opened', { dbPath: env.observability.dbPath });
}

export function getObservabilityStore(): ObservabilityStore {
  if (!_store) throw new Error('Observability store not initialised — call bootObservability() first');
  return _store;
}
