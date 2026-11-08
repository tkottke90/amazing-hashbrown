import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  makeBlockOnUserActionTool,
  type BlockOnUserActionCall,
} from './block-on-user-action.tool.js';

describe('agents/tools/block-on-user-action', () => {
  function makeTool() {
    const accepted: BlockOnUserActionCall[] = [];
    const tool = makeBlockOnUserActionTool('task-1', {
      onAccepted: (c) => accepted.push(c),
    });
    return { tool, accepted };
  }

  it('accepts a call and records the note, with no nudge-once gate (issue #367) [unit]', async () => {
    const { tool, accepted } = makeTool();
    const result = await tool.invoke({
      note: 'Complete the OAuth consent flow and drop credentials.json in config/.',
    });

    expect(result).to.equal(
      'Task task-1 blocked on user action: Complete the OAuth consent flow and drop credentials.json in config/.',
    );
    expect(accepted).to.deep.equal([
      { note: 'Complete the OAuth consent flow and drop credentials.json in config/.' },
    ]);
  });

  it('accepts a second call the same way, unlike hand_off_task it never rejects a first call [unit]', async () => {
    const { tool, accepted } = makeTool();
    await tool.invoke({ note: 'first' });
    const result = await tool.invoke({ note: 'second' });

    expect(result).to.equal('Task task-1 blocked on user action: second');
    expect(accepted).to.deep.equal([{ note: 'first' }, { note: 'second' }]);
  });
});
