import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import type { CronRepeatConfig } from '../../services/cron-config.js';
import { bootCronRegistry } from '../../services/cron-registry.js';
import { makeDisableRecurrenceTool } from './disable-recurrence.tool.js';

const NOW = new Date('2026-10-28T00:00:00.000Z');

function repeatConfig(overrides: Partial<CronRepeatConfig> = {}): CronRepeatConfig {
  return {
    expression: '0 0 * * *',
    timezone: 'UTC',
    enabled: true,
    maxIterations: null,
    stopAfter: null,
    maxConsecutiveFailures: 3,
    enabledAt: '2026-10-01T00:00:00.000Z',
    lastFiredAt: '2026-10-27T00:00:00.000Z',
    consecutiveFailures: 0,
    pausedReason: null,
    ...overrides,
  };
}

describe('agents/tools/disable-recurrence', () => {
  let dir: string;
  let store: WorkspaceStore;
  let syncCalls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'disable-recurrence-tool-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    syncCalls = [];
    // bootCronRegistry() replaces the module-level singleton the tool reads
    // via getCronRegistry() — never real timers, per cron-registry.test.ts's
    // own convention.
    const registry = bootCronRegistry({
      store: () => store,
      now: () => NOW,
      setTimer: () => {
        throw new Error('test should never arm a real timer');
      },
      clearTimer: () => {},
    });
    const originalSync = registry.sync.bind(registry);
    registry.sync = (taskId: string) => {
      syncCalls.push(taskId);
      originalSync(taskId);
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTask(triggerConfig: CronRepeatConfig | null) {
    return store.createTask({
      title: 'Refactor the scheduler',
      triggerType: 'cron_repeat',
      triggerConfig,
    });
  }

  it('disables an enabled schedule and resyncs the registry [unit]', async () => {
    const task = makeTask(repeatConfig());
    const result = await makeDisableRecurrenceTool(task.id, store).invoke({});

    expect(result).to.include('disabled');
    expect(store.getTask(task.id)!.triggerConfig).to.include({
      enabled: false,
      pausedReason: 'no_further_runs_needed',
    });
    expect(syncCalls).to.deep.equal([task.id]);
  });

  it('no-ops without mutating state when the schedule is already off [unit]', async () => {
    const task = makeTask(repeatConfig({ enabled: false }));
    const result = await makeDisableRecurrenceTool(task.id, store).invoke({});

    expect(result).to.equal('Recurrence is already off.');
    expect(store.getTask(task.id)!.triggerConfig).to.include({ enabled: false });
    expect(syncCalls).to.deep.equal([]);
  });

  it('never overwrites an existing pausedReason, e.g. a consecutive-failures auto-pause [unit]', async () => {
    const task = makeTask(repeatConfig({ enabled: false, pausedReason: 'consecutive_failures' }));
    await makeDisableRecurrenceTool(task.id, store).invoke({});

    expect(store.getTask(task.id)!.triggerConfig).to.include({
      pausedReason: 'consecutive_failures',
    });
  });

  it('refuses a non-cron task, since disable_recurrence should never be bound for one [unit]', async () => {
    const task = store.createTask({ title: 'Plain one-off task' });
    const result = await makeDisableRecurrenceTool(task.id, store).invoke({});

    expect(result).to.include('not a recurring task');
    expect(syncCalls).to.deep.equal([]);
  });

  it('refuses a cron_once task — a one-shot has nothing left to disable [unit]', async () => {
    const task = store.createTask({
      title: 'One-shot reminder',
      triggerType: 'cron_once',
      triggerConfig: {
        fireAt: '2026-11-01T00:00:00.000Z',
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-10-01T00:00:00.000Z',
        lastFiredAt: null,
      },
    });
    const result = await makeDisableRecurrenceTool(task.id, store).invoke({});

    expect(result).to.include('not a recurring task');
    expect(syncCalls).to.deep.equal([]);
  });

  it('returns an error string instead of throwing when the task no longer exists [unit]', async () => {
    const result = await makeDisableRecurrenceTool('missing-task', store).invoke({});

    expect(result).to.include('not a recurring task');
  });

  it('returns an error string for a cron_repeat task with no schedule configured yet [unit]', async () => {
    const task = makeTask(null);
    const result = await makeDisableRecurrenceTool(task.id, store).invoke({});

    expect(result).to.include('no schedule configured');
    expect(syncCalls).to.deep.equal([]);
  });
});
