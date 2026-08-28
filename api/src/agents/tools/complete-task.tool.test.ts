import { describe, it } from 'mocha';
import { expect } from 'chai';
import { makeCompleteTaskTool } from './complete-task.tool.js';

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
});
