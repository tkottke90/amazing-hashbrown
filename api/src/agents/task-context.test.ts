import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildTaskContextBlock, formatPlanChecklist } from './task-context.js';

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
});
