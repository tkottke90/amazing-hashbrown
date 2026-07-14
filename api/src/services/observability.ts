import { ObservabilityStore } from '@tkottke90/observability';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';

let _store: ObservabilityStore | null = null;

export function bootObservability(db: SqliteDatabase): void {
  _store = new ObservabilityStore(db);
  logger.info('Observability store opened');
}

export function getObservabilityStore(): ObservabilityStore {
  if (!_store)
    throw new Error('Observability store not initialised — call bootObservability() first');
  return _store;
}
