import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Registry } from '@prometheus-io/client';
import type { WorkspaceStore } from '../workspace-store.js';
import { registerTaskRunsCollector } from './task-runs.collector.js';

interface Stubs {
  runStats: { tasks: number; runs: number };
  planStats: { tasksWithPlan: number; planSteps: number };
  durations: Array<{ provider: string; model: string; count: number; seconds: number }>;
}

function setup(initial: Partial<Stubs> = {}) {
  const state: Stubs = {
    runStats: { tasks: 0, runs: 0 },
    planStats: { tasksWithPlan: 0, planSteps: 0 },
    durations: [],
    ...initial,
  };
  const registry = new Registry();
  registerTaskRunsCollector(
    registry,
    () =>
      ({
        queryDoneTaskRunStats: () => state.runStats,
        queryDonePlanStats: () => state.planStats,
        queryTaskRunDurations: () => state.durations,
      }) as unknown as WorkspaceStore,
  );
  return { state, registry };
}

describe('services/telemetry/task-runs.collector', () => {
  it('exposes done-Task and Run totals so runs-per-task is a ratio of two gauges [unit]', async () => {
    const out = await setup({ runStats: { tasks: 4, runs: 10 } }).registry.metrics();
    expect(out).to.include('hashbrown_done_tasks 4');
    expect(out).to.include('hashbrown_done_task_runs 10');
  });

  it('exposes plan step totals and the count of Tasks that had a plan [unit]', async () => {
    const out = await setup({ planStats: { tasksWithPlan: 3, planSteps: 12 } }).registry.metrics();
    expect(out).to.include('hashbrown_done_tasks_with_plan 3');
    expect(out).to.include('hashbrown_done_task_plan_steps 12');
  });

  it('exposes Run count and seconds per provider/model as separate series [unit]', async () => {
    const out = await setup({
      durations: [
        { provider: 'ollama', model: 'qwen', count: 2, seconds: 90 },
        { provider: 'anthropic', model: 'qwen', count: 1, seconds: 10 },
      ],
    }).registry.metrics();
    expect(out).to.include('hashbrown_task_runs_finished{provider="ollama",model="qwen"} 2');
    expect(out).to.include('hashbrown_task_run_seconds{provider="ollama",model="qwen"} 90');
    expect(out).to.include('hashbrown_task_runs_finished{provider="anthropic",model="qwen"} 1');
  });

  it('reports zeroes, not missing series, when nothing is done yet [unit]', async () => {
    const out = await setup().registry.metrics();
    expect(out).to.include('hashbrown_done_tasks 0');
    expect(out).to.include('hashbrown_done_task_plan_steps 0');
  });

  it('replaces values on each scrape rather than accumulating them [unit]', async () => {
    const { state, registry } = setup({ runStats: { tasks: 5, runs: 9 } });
    await registry.metrics();
    state.runStats = { tasks: 2, runs: 3 };
    const out = await registry.metrics();
    expect(out).to.include('hashbrown_done_tasks 2');
    expect(out).to.not.include('hashbrown_done_tasks 5');
  });

  it('drops a provider/model series that no longer has Runs [unit]', async () => {
    const { state, registry } = setup({
      durations: [{ provider: 'ollama', model: 'gone', count: 1, seconds: 5 }],
    });
    await registry.metrics();
    state.durations = [];
    expect(await registry.metrics()).to.not.include('model="gone"');
  });

  it('declares every metric as a gauge, not a counter [unit]', async () => {
    const out = await setup().registry.metrics();
    for (const name of [
      'hashbrown_done_tasks',
      'hashbrown_done_task_runs',
      'hashbrown_done_tasks_with_plan',
      'hashbrown_done_task_plan_steps',
      'hashbrown_task_runs_finished',
      'hashbrown_task_run_seconds',
    ]) {
      expect(out).to.include(`# TYPE ${name} gauge`);
    }
  });
});
