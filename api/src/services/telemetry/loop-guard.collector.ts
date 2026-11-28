import { Gauge, type Registry } from '@prometheus-io/client';
import type { ThreadStore } from '../thread-store.js';
import type { WorkspaceStore } from '../workspace-store.js';

/**
 * Registers the Loop-Guard Escalation gauges. They are gauges of what is
 * stored right now, not counters: threads and Tasks are deletable, so a
 * derived total can fall (ADR-0078). `collect()` stays synchronous so two
 * overlapping scrapes can't interleave the reset and the sets.
 */
export function registerLoopGuardCollector(
  registry: Registry,
  getThreadStore: () => ThreadStore,
  getWorkspaceStore: () => WorkspaceStore,
): void {
  new Gauge({
    name: 'hashbrown_loop_guard_escalations',
    help: 'Loop-Guard Escalations currently stored, by prompt kind, owning thread type and Escalation Answer (continue, stop_and_summarize, custom, pending).',
    labelNames: ['kind', 'context', 'answer'],
    registers: [registry],
    collect() {
      this.reset();
      for (const row of getThreadStore().queryLoopGuardEscalations()) {
        this.set({ kind: row.kind, context: row.context, answer: row.answer }, row.count);
      }
    },
  });

  new Gauge({
    name: 'hashbrown_loop_guard_escalation_outcomes',
    help: 'Answered Loop-Guard Escalations by Escalation Answer and how the Run ended (done, blocked, other; a Run still in flight reads as other).',
    labelNames: ['answer', 'outcome'],
    registers: [registry],
    collect() {
      this.reset();
      for (const row of getWorkspaceStore().queryEscalationOutcomes()) {
        this.set({ answer: row.answer, outcome: row.outcome }, row.count);
      }
    },
  });
}
