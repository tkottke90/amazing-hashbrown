import { createHash } from 'node:crypto';
import { CostStore } from '@tkottke90/observability';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { env, type CostEntry } from '../config/env.js';
import { logger } from '../config/logger.js';

let _store: CostStore | null = null;

export function bootUsage(db: SqliteDatabase): void {
  _store = new CostStore(db);
}

export function getUsageStore(): CostStore {
  if (!_store) throw new Error('Usage store not initialised — call bootUsage() first');
  return _store;
}

function computeHash(entry: CostEntry): string {
  return createHash('sha256')
    .update(JSON.stringify({ i: entry.inputPer1kTokens, o: entry.outputPer1kTokens }))
    .digest('hex');
}

export function seedProviderCosts(): void {
  const store = getUsageStore();
  const costsConfig = env.costs;
  const active = store.getActiveCosts();
  const now = new Date().toISOString();

  let closed = 0;
  let inserted = 0;

  // Close records whose key was removed from config
  for (const record of active) {
    const key = `${record.providerName}/${record.model}`;
    if (!(key in costsConfig)) {
      store.closeCostRecord(record.id, now);
      closed++;
    }
  }

  // Upsert records from config
  for (const [key, entry] of Object.entries(costsConfig)) {
    // Split on the first '/' only so model names that contain '/' are handled correctly
    const slashIdx = key.indexOf('/');
    if (slashIdx === -1) {
      logger.warn(`Cost config key "${key}" is missing a '/' separator — skipping`);
      continue;
    }
    const providerName = key.slice(0, slashIdx);
    const model = key.slice(slashIdx + 1);
    const hash = computeHash(entry);
    const existing = active.find((r) => r.providerName === providerName && r.model === model);

    if (!existing) {
      store.insertCostRecord({ providerName, model, ...entry, configHash: hash, validFrom: now });
      inserted++;
    } else if (existing.configHash !== hash) {
      store.closeCostRecord(existing.id, now);
      store.insertCostRecord({ providerName, model, ...entry, configHash: hash, validFrom: now });
      closed++;
      inserted++;
    }
    // unchanged hash → no-op
  }

  logger.info('Cost seeder complete', {
    active: active.length,
    closed,
    inserted,
  });
}
