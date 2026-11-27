import { Counter, type Registry } from '@prometheus-io/client';
import type { ObservabilityStore } from '@tkottke90/observability';

/**
 * Registers the per-tool call and failure counters from the all-time
 * tool-call span stats. Failure rate is left to PromQL
 * (`rate(failures) / rate(calls)`). HITL-interrupted spans are never counted
 * as failures — `queryToolCallStats()` already excludes them.
 */
export function registerToolCallsCollector(
  registry: Registry,
  getStore: () => ObservabilityStore,
): void {
  new Counter({
    name: 'hashbrown_tool_calls_total',
    help: 'Cumulative tool calls by tool name.',
    labelNames: ['tool'],
    registers: [registry],
    collect() {
      this.reset();
      for (const row of getStore().queryToolCallStats()) {
        this.inc({ tool: row.name }, row.total);
      }
    },
  });

  new Counter({
    name: 'hashbrown_tool_call_failures_total',
    help: 'Cumulative failed tool calls by tool name.',
    labelNames: ['tool'],
    registers: [registry],
    collect() {
      this.reset();
      for (const row of getStore().queryToolCallStats()) {
        this.inc({ tool: row.name }, row.failed);
      }
    },
  });
}
