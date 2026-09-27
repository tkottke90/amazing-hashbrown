import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'mocha';
import { parse } from 'yaml';
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
          'Decide this now, before doing anything else: does that summary already give you a ' +
            'concrete fact you can act on directly — "0 advisories, nothing open" means there\'s ' +
            "nothing to compare against — or does it leave out specifics you'd need, like a count " +
            'with no names or "see the transcript for details"? If it already answers what you ' +
            "need, get on with the work; don't open the transcript just to double-check something " +
            "it already told you. If it doesn't, call " +
            'read_task_run({"runId":"run-2"}) now, instead of guessing at ' +
            'what it left out.',
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

  // suites/scheduled-task-runs.yaml hands the model a kickoff message as a
  // literal `input` string — the eval harness never calls buildRunKickoff()
  // itself. So if the kickoff wording changes and the suite doesn't, every
  // eval run silently tests the old wording. This rebuilds each scenario's
  // kickoff from the same fixture the suite describes and requires the two
  // to match, so a wording change fails here until the suite is updated.
  describe('suites/scheduled-task-runs.yaml stays in sync with buildRunKickoff()', () => {
    const suitePath = fileURLToPath(
      new URL('../../../suites/scheduled-task-runs.yaml', import.meta.url),
    );
    const suite = parse(readFileSync(suitePath, 'utf-8')) as {
      scenarios: { id: string; input: string }[];
    };
    const inputOf = (id: string) =>
      suite.scenarios.find((s) => s.id === id)?.input.replace(/\n+$/, '');

    // The run history both scenarios describe: this is manual run #3 of the
    // task; run #2 finished at 2026-09-19 09:00 UTC; run #1 before that.
    const kickoffWithPreviousSummary = (summary: string) =>
      buildRunKickoff({
        title: 'Weekly dependency audit',
        resume: false,
        runNumber: 3,
        triggerSource: 'manual',
        previousRuns: [
          {
            id: '6f0c2a1e-4b7d-4c1a-9a55-2f1b8e7d3c90',
            runNumber: 2,
            status: 'done',
            startedAt: '2026-09-19T09:00:00.000Z',
            summary,
          },
          {
            id: '1d9e8b7a-0c3f-4e21-8b6a-7a5c4d3e2f10',
            runNumber: 1,
            status: 'done',
            startedAt: '2026-09-12T09:00:00.000Z',
            summary: 'Audit complete.',
          },
        ],
      });

    it('str-001 sends exactly the kickoff a vague previous summary produces [unit]', () => {
      expect(inputOf('str-001-reads-previous-run-when-summary-lacks-detail')).to.equal(
        kickoffWithPreviousSummary(
          'Audit complete: found 3 high-severity advisories (package names and advisory ids are in the run transcript).',
        ),
      );
    });

    it('str-002 sends exactly the kickoff a complete previous summary produces [unit]', () => {
      expect(inputOf('str-002-skips-history-when-summary-suffices')).to.equal(
        kickoffWithPreviousSummary(
          'Audit complete: 0 advisories of any severity; nothing was open.',
        ),
      );
    });

    it('str-003 (held out) sends exactly the kickoff its complete summary produces [unit]', () => {
      expect(inputOf('str-003-skips-history-held-out')).to.equal(
        kickoffWithPreviousSummary(
          'All 14 dependencies are on their latest patch versions; no advisories were reported.',
        ),
      );
    });

    it('str-004 (held out) sends exactly the kickoff its vague summary produces [unit]', () => {
      expect(inputOf('str-004-reads-history-held-out')).to.equal(
        kickoffWithPreviousSummary('Audit finished; several packages were flagged for follow-up.'),
      );
    });

    it('str-005 (catch-up) sends exactly the kickoff a catch-up run produces [unit]', () => {
      expect(inputOf('str-005-catch-up-reads-history')).to.equal(
        buildRunKickoff({
          title: 'Weekly dependency audit',
          resume: false,
          runNumber: 4,
          triggerSource: 'catch_up',
          scheduledFor: '2026-09-26T09:00:00.000Z',
          previousRuns: [
            {
              id: '9b3e5d71-2a4c-4f86-b0d2-5c8e1f7a6b43',
              runNumber: 3,
              status: 'done',
              startedAt: '2026-09-19T09:00:00.000Z',
              summary:
                'Audit ran clean apart from a handful of transitive packages that need a closer look.',
            },
            {
              id: '6f0c2a1e-4b7d-4c1a-9a55-2f1b8e7d3c90',
              runNumber: 2,
              status: 'done',
              startedAt: '2026-09-12T09:00:00.000Z',
              summary: 'Audit complete.',
            },
            {
              id: '1d9e8b7a-0c3f-4e21-8b6a-7a5c4d3e2f10',
              runNumber: 1,
              status: 'done',
              startedAt: '2026-09-05T09:00:00.000Z',
              summary: 'Audit complete.',
            },
          ],
        }),
      );
    });
  });
});
