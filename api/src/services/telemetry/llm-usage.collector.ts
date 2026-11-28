import { Counter, type Registry } from '@prometheus-io/client';
import type { CostStore } from '@tkottke90/observability';

// Inclusive bounds covering every stored row. The dashboard Metrics use
// "today" as the upper bound; that would hide rows dated ahead of UTC until
// the date catches up, so the Telemetry Endpoint takes everything instead.
const EPOCH_FLOOR = '1970-01-01';
const FAR_FUTURE = '9999-12-31';

interface Totals {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Registers the provider/model token and cost counters. Values are the
 * cumulative totals in the Cost Store, recomputed on every scrape (see the
 * Telemetry ADR) — `collect()` is deliberately synchronous so two overlapping
 * scrapes can't interleave the reset and the increments.
 */
export function registerLlmUsageCollector(registry: Registry, getStore: () => CostStore): void {
  // Grouped by a tuple-keyed Map, never a joined string, so a provider or
  // model name can't collide with another pair.
  function totalsByProviderModel(): Totals[] {
    const byProvider = new Map<string, Map<string, Totals>>();
    for (const row of getStore().queryUsage({ from: EPOCH_FLOOR, to: FAR_FUTURE })) {
      let models = byProvider.get(row.provider);
      if (!models) byProvider.set(row.provider, (models = new Map()));
      let totals = models.get(row.model);
      if (!totals) {
        models.set(
          row.model,
          (totals = {
            provider: row.provider,
            model: row.model,
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
          }),
        );
      }
      totals.inputTokens += row.inputTokens;
      totals.outputTokens += row.outputTokens;
      totals.cost += row.estimatedCost;
    }
    return [...byProvider.values()].flatMap((models) => [...models.values()]);
  }

  new Counter({
    name: 'hashbrown_llm_tokens_total',
    help: 'Cumulative LLM tokens by provider, model and direction (input or output).',
    labelNames: ['provider', 'model', 'direction'],
    registers: [registry],
    collect() {
      this.reset();
      for (const t of totalsByProviderModel()) {
        this.inc({ provider: t.provider, model: t.model, direction: 'input' }, t.inputTokens);
        this.inc({ provider: t.provider, model: t.model, direction: 'output' }, t.outputTokens);
      }
    },
  });

  new Counter({
    name: 'hashbrown_llm_cost_usd_total',
    help: 'Cumulative estimated LLM spend in USD by provider and model.',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const t of totalsByProviderModel()) {
        this.inc({ provider: t.provider, model: t.model }, t.cost);
      }
    },
  });
}
