import { createHash } from 'node:crypto';
import { CostStore } from '@tkottke90/observability';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { env, type ModelConfig } from '../config/env.js';
import { logger } from '../config/logger.js';

let _store: CostStore | null = null;

export function bootUsage(db: SqliteDatabase): void {
  _store = new CostStore(db);
}

export function getUsageStore(): CostStore {
  if (!_store) throw new Error('Usage store not initialised — call bootUsage() first');
  return _store;
}

function computeHash(entry: Pick<ModelConfig, 'inputPricePerM' | 'outputPricePerM'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ i: entry.inputPricePerM, o: entry.outputPricePerM }))
    .digest('hex');
}

/**
 * Upserts provider_costs rows (the external CostStore's own historical-price
 * table) from providers[].models[] pricing instead of the legacy top-level
 * `costs` map — see
 * docs/superpowers/specs/2026-10-14-per-model-sampling-pricing-config-design.md
 * §4. Also logs a warning for every `costs` entry still present, since that
 * map is no longer read for pricing at all: this runs at boot and again
 * after every settings reload, so the warning (and the Settings UI's
 * matching banner) stays in sync as entries are migrated live.
 */
export function seedProviderCosts(): void {
  const store = getUsageStore();
  const active = store.getActiveCosts();
  const now = new Date().toISOString();

  const legacyKeys = Object.keys(env.costs);
  for (const key of legacyKeys) {
    logger.warn(
      `config: legacy cost entry "${key}" in costs: — move it into providers[].models[] (see docs/App-Docs/Providers.md)`,
    );
  }

  // Desired state: every (providerName, model.id) with at least one price set.
  const desired = env.providers.flatMap((p) =>
    (p.models ?? [])
      .filter((m) => m.inputPricePerM !== undefined || m.outputPricePerM !== undefined)
      .map((m) => ({ providerName: p.name, model: m.id, entry: m })),
  );

  let closed = 0;
  let inserted = 0;

  // Close records whose provider/model no longer has pricing configured.
  for (const record of active) {
    const stillDesired = desired.some(
      (d) => d.providerName === record.providerName && d.model === record.model,
    );
    if (!stillDesired) {
      store.closeCostRecord(record.id, now);
      closed++;
    }
  }

  // Upsert records from config, converting per-million to the store's
  // per-1,000-token unit at this boundary — InsertCostRecord has no
  // scale/unit field of its own, it is always per-1k.
  for (const { providerName, model, entry } of desired) {
    const hash = computeHash(entry);
    const existing = active.find((r) => r.providerName === providerName && r.model === model);
    const record = {
      providerName,
      model,
      inputPer1kTokens: (entry.inputPricePerM ?? 0) / 1000,
      outputPer1kTokens: (entry.outputPricePerM ?? 0) / 1000,
      configHash: hash,
      validFrom: now,
    };

    if (!existing) {
      store.insertCostRecord(record);
      inserted++;
    } else if (existing.configHash !== hash) {
      store.closeCostRecord(existing.id, now);
      store.insertCostRecord(record);
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
