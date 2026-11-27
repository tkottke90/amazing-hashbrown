import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Registry } from '@prometheus-io/client';
import type { CostStore, UsageRow } from '@tkottke90/observability';
import { registerLlmUsageCollector } from './llm-usage.collector.js';

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    date: '2026-01-01',
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0.5,
    ...overrides,
  };
}

function setup(initial: UsageRow[]) {
  const state = { rows: initial };
  const registry = new Registry();
  registerLlmUsageCollector(
    registry,
    () => ({ queryUsage: () => state.rows }) as unknown as CostStore,
  );
  return { state, registry };
}

describe('services/telemetry/llm-usage.collector', () => {
  it('sums input and output tokens per provider/model with a direction label [unit]', async () => {
    const { registry } = setup([
      row({ date: '2026-01-01', inputTokens: 100, outputTokens: 50 }),
      row({ date: '2026-01-02', inputTokens: 10, outputTokens: 5 }),
    ]);
    const out = await registry.metrics();
    expect(out).to.include(
      'hashbrown_llm_tokens_total{provider="anthropic",model="claude-sonnet",direction="input"} 110',
    );
    expect(out).to.include(
      'hashbrown_llm_tokens_total{provider="anthropic",model="claude-sonnet",direction="output"} 55',
    );
  });

  it('keeps different provider/model pairs as separate series [unit]', async () => {
    const { registry } = setup([
      row({ provider: 'anthropic', model: 'a', inputTokens: 1 }),
      row({ provider: 'ollama', model: 'a', inputTokens: 7 }),
    ]);
    const out = await registry.metrics();
    expect(out).to.include('provider="anthropic",model="a",direction="input"} 1');
    expect(out).to.include('provider="ollama",model="a",direction="input"} 7');
  });

  it('sums estimated cost per provider/model [unit]', async () => {
    const { registry } = setup([
      row({ estimatedCost: 0.25 }),
      row({ date: '2026-01-02', estimatedCost: 0.5 }),
    ]);
    const out = await registry.metrics();
    expect(out).to.include(
      'hashbrown_llm_cost_usd_total{provider="anthropic",model="claude-sonnet"} 0.75',
    );
  });

  it('emits no series, and does not throw, when there is no usage [unit]', async () => {
    const { registry } = setup([]);
    const out = await registry.metrics();
    expect(out).to.include('# TYPE hashbrown_llm_tokens_total counter');
    expect(out).to.not.include('hashbrown_llm_tokens_total{');
  });

  it('reports the same totals on consecutive scrapes instead of double counting [unit]', async () => {
    const { registry } = setup([row({ inputTokens: 100 })]);
    const first = await registry.metrics();
    const second = await registry.metrics();
    expect(second).to.equal(first);
  });

  it('reflects new usage on the next scrape as a higher cumulative value [unit]', async () => {
    const { state, registry } = setup([row({ inputTokens: 100 })]);
    await registry.metrics();
    state.rows = [row({ inputTokens: 100 }), row({ date: '2026-01-02', inputTokens: 25 })];
    expect(await registry.metrics()).to.include('direction="input"} 125');
  });

  it('escapes quotes and newlines in label values [unit]', async () => {
    const { registry } = setup([row({ model: 'we"ird\nname' })]);
    expect(await registry.metrics()).to.include('model="we\\"ird\\nname"');
  });
});
