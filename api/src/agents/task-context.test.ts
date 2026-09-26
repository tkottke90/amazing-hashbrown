import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  buildRunKickoff,
  buildTaskContextBlock,
  formatPlanChecklist,
  formatRunTime,
  type PreviousRun,
} from './task-context.js';

const PLAN = [
  { step: 'Scaffold the route', done: true },
  { step: 'Add tests', done: false },
  { step: 'Update docs', done: false },
];

describe('agents/task-context', () => {
  describe('formatPlanChecklist()', () => {
    it('numbers steps from 1 so the numbers match what update_plan accepts [unit]', () => {
      expect(formatPlanChecklist(PLAN)).to.equal(
        '1. [x] Scaffold the route\n2. [ ] Add tests\n3. [ ] Update docs',
      );
    });

    it('renders an empty string for an empty plan [unit]', () => {
      expect(formatPlanChecklist([])).to.equal('');
    });
  });

  describe('buildTaskContextBlock()', () => {
    it('always states the task title and the complete_task/ask_user instruction [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'Summarize the inbox',
        description: null,
        outcome: null,
      });
      expect(block).to.include('"Summarize the inbox"');
      expect(block).to.include('complete_task');
      expect(block).to.include('ask_user');
    });

    it('includes the description when present [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: 'Read every unread email and summarize it.',
        outcome: null,
      });
      expect(block).to.include('Read every unread email and summarize it.');
    });

    it('omits a description line when absent [unit]', () => {
      const block = buildTaskContextBlock({ title: 'T', description: null, outcome: null });
      expect(block).to.not.include('Description:');
    });

    it('includes the outcome when present [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: 'A markdown summary page exists in the wiki.',
      });
      expect(block).to.include('A markdown summary page exists in the wiki.');
    });

    it('omits an outcome line when absent [unit]', () => {
      const block = buildTaskContextBlock({ title: 'T', description: null, outcome: null });
      expect(block).to.not.include('Outcome to reach:');
    });

    it('omits the ask_user instruction and states no one is available when hasAskUser is false (sub-agent runs — issue #161) [unit]', () => {
      const block = buildTaskContextBlock({ title: 'T', description: null, outcome: null }, false);
      expect(block).to.include('complete_task');
      expect(block).to.not.include('ask_user');
      expect(block).to.include('No one is available');
    });

    it('still includes the ask_user instruction by default (ordinary task runs, regression) [unit]', () => {
      const block = buildTaskContextBlock({ title: 'T', description: null, outcome: null });
      expect(block).to.include('ask_user');
    });

    it('shows the agent its plan with each step numbered and its done state (issue #203) [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: PLAN,
      });
      expect(block).to.include('1. [x] Scaffold the route');
      expect(block).to.include('2. [ ] Add tests');
      expect(block).to.include('3. [ ] Update docs');
    });

    it('tells the agent to check steps off with update_plan when there is a plan [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: PLAN,
      });
      expect(block).to.include('update_plan');
    });

    it('tells the agent to check a step off immediately, before starting the next step (eval task-plan-progress round 2) [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: PLAN,
      });
      expect(block).to.include('your very next tool call is update_plan');
    });

    it('tells the agent to trust a tool result already shown rather than re-verifying it (eval task-plan-progress round 2) [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: PLAN,
      });
      expect(block).to.include('Trust a tool result already shown earlier in this conversation');
    });

    it('names the complete_task nudge case explicitly for trusting prior results (eval task-plan-progress round 2) [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: PLAN,
      });
      expect(block).to.include('right after complete_task rejects a "done" call');
    });

    it('never mentions update_plan for a task with a null plan — the tool would have nothing to update [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: null,
      });
      expect(block).to.not.include('update_plan');
      expect(block).to.not.include('Plan (');
    });

    it('never mentions update_plan for a task with an empty plan [unit]', () => {
      const block = buildTaskContextBlock({
        title: 'T',
        description: null,
        outcome: null,
        plan: [],
      });
      expect(block).to.not.include('update_plan');
    });

    it('leaves a plan-less block identical to one with no plan field at all (no prompt change for existing tasks) [unit]', () => {
      const base = { title: 'T', description: 'D', outcome: 'O' };
      expect(buildTaskContextBlock({ ...base, plan: [] })).to.equal(buildTaskContextBlock(base));
    });
  });

  describe('buildRunKickoff()', () => {
    const run = (
      n: number,
      status = 'done',
      summary: string | null = `Summary ${n}.`,
    ): PreviousRun => ({
      id: `run-${n}`,
      runNumber: n,
      status,
      startedAt: `2026-09-${String(10 + n).padStart(2, '0')}T09:00:00.000Z`,
      summary,
    });

    it('keeps the plain begin message for a first run, with nothing to look back at [unit]', () => {
      expect(
        buildRunKickoff({
          title: 'Audit',
          resume: false,
          runNumber: 1,
          triggerSource: 'manual',
          previousRuns: [],
        }),
      ).to.equal('Begin work on this task now: Audit.');
    });

    it('resumes without a history block — the thread already holds the run so far [unit]', () => {
      expect(
        buildRunKickoff({
          title: 'Audit',
          resume: true,
          runNumber: 3,
          triggerSource: 'manual',
          previousRuns: [run(2)],
        }),
      ).to.equal('Resume this task — continue from where you left off: Audit.');
    });

    it("carries the previous run's summary and the exact read_task_run call to open it [unit]", () => {
      const text = buildRunKickoff({
        title: 'Audit',
        resume: false,
        runNumber: 3,
        triggerSource: 'manual',
        previousRuns: [run(2), run(1, 'failed')],
      });
      expect(text).to.equal(
        [
          'Begin work on this task now: Audit.',
          'This is run #3 (started manually).',
          '',
          'Previous run — #2, 2026-09-12 09:00 UTC, done:',
          '"Summary 2."',
          'For full details call: read_task_run({"runId":"run-2"})',
          '',
          'Earlier runs: #1 run-1 (failed)',
        ].join('\n'),
      );
    });

    it('lists at most three earlier runs so the kickoff stays short [unit]', () => {
      const text = buildRunKickoff({
        title: 'Audit',
        resume: false,
        runNumber: 7,
        triggerSource: 'manual',
        previousRuns: [run(6), run(5), run(4), run(3), run(2)],
      });
      expect(text).to.include('Earlier runs: #5 run-5 (done), #4 run-4 (done), #3 run-3 (done)');
      expect(text).to.not.include('run-2');
    });

    it('says so when the previous run recorded no summary [unit]', () => {
      const text = buildRunKickoff({
        title: 'Audit',
        resume: false,
        runNumber: 2,
        triggerSource: 'manual',
        previousRuns: [run(1, 'failed', null)],
      });
      expect(text).to.include('"No summary was recorded."');
    });

    it('names the scheduled time for a scheduled run, in the task timezone [unit]', () => {
      const text = buildRunKickoff({
        title: 'Audit',
        resume: false,
        runNumber: 1,
        triggerSource: 'schedule',
        scheduledFor: '2026-09-26T05:00:00.000Z',
        timeZone: 'America/Chicago',
        previousRuns: [],
      });
      expect(text).to.include(
        'This is scheduled run #1 (scheduled for 2026-09-26 00:00 America/Chicago).',
      );
      expect(text).to.not.include('catch-up');
    });

    it('flags a catch-up run so the agent knows it is running late [unit]', () => {
      const text = buildRunKickoff({
        title: 'Audit',
        resume: false,
        runNumber: 4,
        triggerSource: 'catch_up',
        scheduledFor: '2026-09-26T05:00:00.000Z',
        previousRuns: [],
      });
      expect(text).to.include(
        'This is a catch-up run — the server was offline at the scheduled time.',
      );
    });
  });

  describe('formatRunTime()', () => {
    it('renders a fixed 24-hour time with the zone name [unit]', () => {
      expect(formatRunTime('2026-09-26T17:05:00.000Z')).to.equal('2026-09-26 17:05 UTC');
      expect(formatRunTime('2026-09-26T17:05:00.000Z', 'America/Chicago')).to.equal(
        '2026-09-26 12:05 America/Chicago',
      );
    });
  });
});
