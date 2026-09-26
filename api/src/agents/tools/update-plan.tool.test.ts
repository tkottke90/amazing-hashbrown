import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';
import { WorkspaceStore, type PlanStep } from '../../services/workspace-store.js';
import { registerBroadcastClient, unregisterBroadcastClient } from '../../services/broadcast.js';
import { makeUpdatePlanTool } from './update-plan.tool.js';

const PLAN: PlanStep[] = [
  { step: 'Scaffold the route', done: false },
  { step: 'Add tests', done: false },
  { step: 'Update docs', done: false },
];

describe('agents/tools/update-plan', () => {
  let dir: string;
  let store: WorkspaceStore;
  let received: AppBroadcastEvent[];
  const writer = (e: AppBroadcastEvent) => received.push(e);

  function makeTask(plan: PlanStep[] | null = PLAN) {
    return store.createTask({ title: 'Ship the endpoint', plan });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-plan-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    received = [];
    registerBroadcastClient(writer);
  });

  afterEach(() => {
    unregisterBroadcastClient(writer);
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a checked step to the task so the drawer shows it after the run [unit]', async () => {
    const task = makeTask();
    await makeUpdatePlanTool(task.id, store).invoke({ updates: [{ step: 2, done: true }] });

    expect(store.getTask(task.id)!.plan).to.deep.equal([
      { step: 'Scaffold the route', done: false },
      { step: 'Add tests', done: true },
      { step: 'Update docs', done: false },
    ]);
  });

  it('can uncheck a step the agent checked by mistake [unit]', async () => {
    const task = makeTask([{ step: 'Only step', done: true }]);
    await makeUpdatePlanTool(task.id, store).invoke({ updates: [{ step: 1, done: false }] });

    expect(store.getTask(task.id)!.plan).to.deep.equal([{ step: 'Only step', done: false }]);
  });

  it('applies several updates from one call [unit]', async () => {
    const task = makeTask();
    await makeUpdatePlanTool(task.id, store).invoke({
      updates: [
        { step: 1, done: true },
        { step: 3, done: true },
      ],
    });

    expect(store.getTask(task.id)!.plan!.map((s) => s.done)).to.deep.equal([true, false, true]);
  });

  it('returns the full updated checklist so the agent never needs a separate read tool [unit]', async () => {
    const task = makeTask();
    const result = await makeUpdatePlanTool(task.id, store).invoke({
      updates: [{ step: 1, done: true }],
    });

    expect(result).to.include('1. [x] Scaffold the route');
    expect(result).to.include('2. [ ] Add tests');
    expect(result).to.include('3. [ ] Update docs');
  });

  it('builds on the stored plan, not a stale copy, so a human toggle mid-run is kept [unit]', async () => {
    const task = makeTask();
    const updatePlan = makeUpdatePlanTool(task.id, store);
    // A human checks step 3 in the drawer after the tool was built.
    store.patchTask(task.id, {
      plan: PLAN.map((s, i) => (i === 2 ? { ...s, done: true } : s)),
    });

    await updatePlan.invoke({ updates: [{ step: 1, done: true }] });

    expect(store.getTask(task.id)!.plan!.map((s) => s.done)).to.deep.equal([true, false, true]);
  });

  it('broadcasts task_plan_updated with the new plan so open drawers update live [unit]', async () => {
    const task = makeTask();
    await makeUpdatePlanTool(task.id, store).invoke({ updates: [{ step: 1, done: true }] });

    expect(received).to.deep.equal([
      {
        type: 'task_plan_updated',
        taskId: task.id,
        plan: [
          { step: 'Scaffold the route', done: true },
          { step: 'Add tests', done: false },
          { step: 'Update docs', done: false },
        ],
      },
    ]);
  });

  it('rejects the whole call when any step number is out of range, writing nothing [unit]', async () => {
    const task = makeTask();
    const result = await makeUpdatePlanTool(task.id, store).invoke({
      updates: [
        { step: 1, done: true },
        { step: 7, done: true },
      ],
    });

    expect(result).to.include('step 7 does not exist');
    expect(result).to.include('Valid steps are 1-3');
    expect(store.getTask(task.id)!.plan).to.deep.equal(PLAN);
    expect(received).to.deep.equal([]);
  });

  it('tells the agent there is nothing to update when the task has no plan [unit]', async () => {
    const task = makeTask(null);
    const result = await makeUpdatePlanTool(task.id, store).invoke({
      updates: [{ step: 1, done: true }],
    });

    expect(result).to.equal('This task has no plan steps to update.');
    expect(received).to.deep.equal([]);
  });

  it('treats an empty plan the same as no plan [unit]', async () => {
    const task = makeTask([]);
    const result = await makeUpdatePlanTool(task.id, store).invoke({
      updates: [{ step: 1, done: true }],
    });

    expect(result).to.equal('This task has no plan steps to update.');
  });

  it('returns an error string instead of throwing when the task no longer exists [unit]', async () => {
    const result = await makeUpdatePlanTool('missing-task', store).invoke({
      updates: [{ step: 1, done: true }],
    });

    expect(result).to.include('not found');
  });
});
