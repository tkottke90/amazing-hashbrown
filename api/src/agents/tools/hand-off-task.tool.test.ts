import { describe, it } from 'mocha';
import { expect } from 'chai';
import { makeHandOffTaskTool, type HandOffTaskCall } from './hand-off-task.tool.js';

describe('agents/tools/hand-off-task', () => {
  function makeTool(hadHitlInterrupt: boolean | undefined) {
    const accepted: HandOffTaskCall[] = [];
    const tool = makeHandOffTaskTool('task-1', {
      hadHitlInterrupt,
      onAccepted: (c) => accepted.push(c),
    });
    return { tool, accepted };
  }

  describe('nudge-once (issue #364)', () => {
    it('rejects the first call when no ask_user interrupt has occurred this run [unit]', async () => {
      const { tool, accepted } = makeTool(false);
      const result = await tool.invoke({ summary: 'Stopping as asked.' });

      expect(result).to.include('No ask_user interrupt has occurred yet');
      expect(result).to.include('complete_task');
      expect(result).to.include('ask_user');
      expect(accepted).to.deep.equal([]);
    });

    it('accepts the first call when an ask_user interrupt has already occurred [unit]', async () => {
      const { tool, accepted } = makeTool(true);
      const result = await tool.invoke({ summary: "Stopped at the user's request." });

      expect(result).to.equal("Task task-1 handed off: Stopped at the user's request.");
      expect(accepted).to.deep.equal([{ summary: "Stopped at the user's request." }]);
    });

    it('accepts an immediate second call regardless, so the agent is never trapped [unit]', async () => {
      const { tool, accepted } = makeTool(false);
      await tool.invoke({ summary: 'first' });
      const result = await tool.invoke({ summary: 'Handing off anyway.' });

      expect(result).to.equal('Task task-1 handed off: Handing off anyway.');
      expect(accepted).to.deep.equal([{ summary: 'Handing off anyway.' }]);
    });

    it('treats a missing hadHitlInterrupt the same as false [unit]', async () => {
      const { tool, accepted } = makeTool(undefined);
      const result = await tool.invoke({ summary: 'Stopping.' });

      expect(result).to.include('No ask_user interrupt has occurred yet');
      expect(accepted).to.deep.equal([]);
    });
  });
});
