import { ObservabilityStore } from '@tkottke90/observability';
import { logger } from '../config/logger.js';

let _store: ObservabilityStore | null = null;

export function bootObservability(dbPath: string): void {
  _store = ObservabilityStore.open(dbPath);
  logger.info('Observability store opened', { dbPath });
}

export function getObservabilityStore(): ObservabilityStore {
  if (!_store)
    throw new Error('Observability store not initialised — call bootObservability() first');
  return _store;
}
