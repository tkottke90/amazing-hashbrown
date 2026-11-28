import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Registry } from '@prometheus-io/client';
import type { ObservabilityStore, ToolCallStatsRow } from '@tkottke90/observability';
import { registerToolCallsCollector } from './tool-calls.collector.js';

function setup(rows: ToolCallStatsRow[]) {
  const registry = new Registry();
  registerToolCallsCollector(
    registry,
    () => ({ queryToolCallStats: () => rows }) as unknown as ObservabilityStore,
  );
  return registry;
}

describe('services/telemetry/tool-calls.collector', () => {
  it('exposes call and failure counts per tool [unit]', async () => {
    const out = await setup([
      { name: 'wiki_search', total: 10, failed: 2 },
      { name: 'upload_image', total: 3, failed: 0 },
    ]).metrics();
    expect(out).to.include('hashbrown_tool_calls_total{tool="wiki_search"} 10');
    expect(out).to.include('hashbrown_tool_call_failures_total{tool="wiki_search"} 2');
    expect(out).to.include('hashbrown_tool_calls_total{tool="upload_image"} 3');
  });

  it('still emits a zero failure series for a tool that has calls but no failures [unit]', async () => {
    const out = await setup([{ name: 'upload_image', total: 3, failed: 0 }]).metrics();
    expect(out).to.include('hashbrown_tool_call_failures_total{tool="upload_image"} 0');
  });

  it('emits no series when no tool has been called [unit]', async () => {
    const out = await setup([]).metrics();
    expect(out).to.not.include('hashbrown_tool_calls_total{');
  });

  it('reports the same values on consecutive scrapes instead of double counting [unit]', async () => {
    const registry = setup([{ name: 'wiki_search', total: 10, failed: 2 }]);
    const first = await registry.metrics();
    expect(await registry.metrics()).to.equal(first);
  });
});
