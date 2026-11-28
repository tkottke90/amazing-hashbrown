import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Registry } from '@prometheus-io/client';
import type { ThreadStore } from '../thread-store.js';
import type { WorkspaceStore } from '../workspace-store.js';
import { registerLoopGuardCollector } from './loop-guard.collector.js';

type EscalationRow = ReturnType<ThreadStore['queryLoopGuardEscalations']>[number];
type OutcomeRow = ReturnType<WorkspaceStore['queryEscalationOutcomes']>[number];

function setup(escalations: EscalationRow[], outcomes: OutcomeRow[]) {
  const state = { escalations, outcomes };
  const registry = new Registry();
  registerLoopGuardCollector(
    registry,
    () => ({ queryLoopGuardEscalations: () => state.escalations }) as unknown as ThreadStore,
    () => ({ queryEscalationOutcomes: () => state.outcomes }) as unknown as WorkspaceStore,
  );
  return { state, registry };
}

describe('services/telemetry/loop-guard.collector', () => {
  it('exposes escalations with kind, context and answer labels [unit]', async () => {
    const { registry } = setup(
      [{ kind: 'loop_stagnation_warning', context: 'task', answer: 'continue', count: 4 }],
      [],
    );
    const out = await registry.metrics();
    expect(out).to.include(
      'hashbrown_loop_guard_escalations{kind="loop_stagnation_warning",context="task",answer="continue"} 4',
    );
  });

  it('exposes escalation outcomes with answer and outcome labels [unit]', async () => {
    const { registry } = setup(
      [],
      [{ answer: 'stop_and_summarize', outcome: 'blocked', count: 2 }],
    );
    const out = await registry.metrics();
    expect(out).to.include(
      'hashbrown_loop_guard_escalation_outcomes{answer="stop_and_summarize",outcome="blocked"} 2',
    );
  });

  it('declares both metrics as gauges, not counters [unit]', async () => {
    const out = await setup([], []).registry.metrics();
    expect(out).to.include('# TYPE hashbrown_loop_guard_escalations gauge');
    expect(out).to.include('# TYPE hashbrown_loop_guard_escalation_outcomes gauge');
  });

  it('lets a series fall after a deletion instead of keeping its old value [unit]', async () => {
    const { state, registry } = setup(
      [{ kind: 'recursion_limit_warning', context: 'chat', answer: 'pending', count: 5 }],
      [],
    );
    await registry.metrics();
    state.escalations = [
      { kind: 'recursion_limit_warning', context: 'chat', answer: 'pending', count: 2 },
    ];
    const out = await registry.metrics();
    expect(out).to.include('answer="pending"} 2');
    expect(out).to.not.include('answer="pending"} 5');
  });

  it('drops a series that no longer exists in storage [unit]', async () => {
    const { state, registry } = setup(
      [{ kind: 'recursion_limit_warning', context: 'chat', answer: 'custom', count: 1 }],
      [],
    );
    await registry.metrics();
    state.escalations = [];
    const out = await registry.metrics();
    expect(out).to.not.include('answer="custom"');
  });
});
