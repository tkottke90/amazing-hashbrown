import { Gauge, type Registry } from '@prometheus-io/client';
import type { WorkspaceStore } from '../workspace-store.js';

/**
 * Registers the Task Run gauges. Each average is a ratio of two gauges in
 * PromQL, e.g. `hashbrown_done_task_runs / hashbrown_done_tasks`. They are
 * gauges, not counters: Tasks and Runs are deletable and a Task leaves the
 * done set when reopened, so a derived total can fall (ADR-0078).
 */
export function registerTaskRunsCollector(
  registry: Registry,
  getStore: () => WorkspaceStore,
): void {
  new Gauge({
    name: 'hashbrown_done_tasks',
    help: 'Board Tasks currently in the done state (Sub-Agent Tasks excluded).',
    registers: [registry],
    collect() {
      this.set(getStore().queryDoneTaskRunStats().tasks);
    },
  });

  new Gauge({
    name: 'hashbrown_done_task_runs',
    help: 'Runs of any status belonging to done board Tasks. Divide by hashbrown_done_tasks for average Runs per completed Task.',
    registers: [registry],
    collect() {
      this.set(getStore().queryDoneTaskRunStats().runs);
    },
  });

  new Gauge({
    name: 'hashbrown_done_tasks_with_plan',
    help: 'Done board Tasks that have a non-empty plan.',
    registers: [registry],
    collect() {
      this.set(getStore().queryDonePlanStats().tasksWithPlan);
    },
  });

  new Gauge({
    name: 'hashbrown_done_task_plan_steps',
    help: 'Total plan steps across done board Tasks with a plan (the final plan, not the original). Divide by hashbrown_done_tasks_with_plan for the average.',
    registers: [registry],
    collect() {
      this.set(getStore().queryDonePlanStats().planSteps);
    },
  });

  new Gauge({
    name: 'hashbrown_task_runs_finished',
    help: 'Settled Runs by provider and model; unknown when the Run has no trace.',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const row of getStore().queryTaskRunDurations()) {
        this.set({ provider: row.provider, model: row.model }, row.count);
      }
    },
  });

  new Gauge({
    name: 'hashbrown_task_run_seconds',
    help: 'Total wall-clock seconds of settled Runs by provider and model. Includes time spent waiting on a human during a HITL pause. Divide by hashbrown_task_runs_finished for the average.',
    labelNames: ['provider', 'model'],
    registers: [registry],
    collect() {
      this.reset();
      for (const row of getStore().queryTaskRunDurations()) {
        this.set({ provider: row.provider, model: row.model }, row.seconds);
      }
    },
  });
}
