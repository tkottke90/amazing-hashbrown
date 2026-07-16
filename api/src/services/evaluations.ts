import { bootEvaluations as _bootEvaluations, getEvaluationsStore } from '@tkottke90/evaluations';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';

export function bootEvaluations(db: SqliteDatabase): void {
  _bootEvaluations(db);
  logger.info('Evaluations store opened');
}

export { getEvaluationsStore };
