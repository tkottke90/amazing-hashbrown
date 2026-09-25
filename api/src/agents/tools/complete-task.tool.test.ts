import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { PlanStep } from '../../services/workspace-store.js';
import { makeCompleteTaskTool, type CompleteTaskCall } from './complete-task.tool.js';

describe('agents/tools/complete-task', () => {
  it('returns a string confirming the outcome for "done"', async () => {
    const tool = makeCompleteTaskTool('task-1');
    const result = await tool.invoke({ outcome: 'done', summary: 'Wrote the new wiki page.' });
    expect(result).to.equal('Task task-1 marked done: Wrote the new wiki page.');
  });

  it('returns a string confirming the outcome for "failed"', async () => {
    const tool = makeCompleteTaskTool('task-2');
    const result = await tool.invoke({
      outcome: 'failed',
      summary: 'Could not resolve the target wiki domain.',
    });
    expect(result).to.equal('Task task-2 marked failed: Could not resolve the target wiki domain.');
  });

  describe('plan nudge (issue #203)', () => {
    const MIXED: PlanStep[] = [
      { step: 'Scaffold the route', done: true },
      { step: 'Add tests', done: false },
      { step: 'Update docs', done: false },
    ];

    function makeTool(plan: PlanStep[] | null) {
      const accepted: CompleteTaskCall[] = [];
      const tool = makeCompleteTaskTool('task-1', {
        getPlan: () => plan,
        onAccepted: (c) => accepted.push(c),
      });
      return { tool, accepted };
    }

    it('rejects the first "done" while steps are unchecked, naming them so the agent can check them off [unit]', async () => {
      const { tool, accepted } = makeTool(MIXED);
      const result = await tool.invoke({ outcome: 'done', summary: 'All done.' });

      expect(result).to.include('Not completed: steps 2, 3 are still unchecked');
      expect(result).to.include('update_plan');
      expect(result).to.include('2. [ ] Add tests');
      expect(accepted).to.deep.equal([]);
    });

    it('uses the singular wording when exactly one step is unchecked [unit]', async () => {
      const { tool } = makeTool([
        { step: 'A', done: true },
        { step: 'B', done: false },
      ]);
      const result = await tool.invoke({ outcome: 'done', summary: 's' });

      expect(result).to.include('step 2 is still unchecked');
    });

    it('accepts the second "done" regardless, so a deliberately skipped step never traps the run [unit]', async () => {
      const { tool, accepted } = makeTool(MIXED);
      await tool.invoke({ outcome: 'done', summary: 'first' });
      const result = await tool.invoke({ outcome: 'done', summary: 'Skipped docs on purpose.' });

      expect(result).to.equal('Task task-1 marked done: Skipped docs on purpose.');
      expect(accepted).to.deep.equal([{ outcome: 'done', summary: 'Skipped docs on purpose.' }]);
    });

    it('accepts "done" immediately when every step is already checked [unit]', async () => {
      const { tool, accepted } = makeTool(MIXED.map((s) => ({ ...s, done: true })));
      await tool.invoke({ outcome: 'done', summary: 'Everything shipped.' });

      expect(accepted).to.deep.equal([{ outcome: 'done', summary: 'Everything shipped.' }]);
    });

    it('re-reads the plan on each call, so steps checked after a nudge are seen [unit]', async () => {
      let plan = MIXED;
      const accepted: CompleteTaskCall[] = [];
      const tool = makeCompleteTaskTool('task-1', {
        getPlan: () => plan,
        onAccepted: (c) => accepted.push(c),
      });

      await tool.invoke({ outcome: 'done', summary: 'first' });
      plan = MIXED.map((s) => ({ ...s, done: true }));
      await tool.invoke({ outcome: 'done', summary: 'second' });

      expect(accepted).to.deep.equal([{ outcome: 'done', summary: 'second' }]);
    });

    it('never nudges "failed" — a run that cannot proceed must always be able to stop [unit]', async () => {
      const { tool, accepted } = makeTool(MIXED);
      await tool.invoke({ outcome: 'failed', summary: 'Blocked on credentials.' });

      expect(accepted).to.deep.equal([{ outcome: 'failed', summary: 'Blocked on credentials.' }]);
    });

    it('accepts "done" for a task with no plan [unit]', async () => {
      const { tool, accepted } = makeTool(null);
      await tool.invoke({ outcome: 'done', summary: 's' });

      expect(accepted).to.have.length(1);
    });

    it('accepts "done" for a task with an empty plan [unit]', async () => {
      const { tool, accepted } = makeTool([]);
      await tool.invoke({ outcome: 'done', summary: 's' });

      expect(accepted).to.have.length(1);
    });

    it('never nudges without getPlan (sub-agent runs keep their current behavior) [unit]', async () => {
      const accepted: CompleteTaskCall[] = [];
      const tool = makeCompleteTaskTool('task-1', { onAccepted: (c) => accepted.push(c) });
      const result = await tool.invoke({ outcome: 'done', summary: 's' });

      expect(result).to.equal('Task task-1 marked done: s');
      expect(accepted).to.have.length(1);
    });
  });
});
