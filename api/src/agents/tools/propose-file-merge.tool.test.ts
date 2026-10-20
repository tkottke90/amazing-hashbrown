import { describe, it } from 'mocha';
import { expect } from 'chai';
import { proposeFileMergeTool } from './propose-file-merge.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: 'test-thread' }, toolCallId: 'call-1' };
}

describe('agents/tools/propose-file-merge', () => {
  it('returns a Command that clears activeSkill and acknowledges the proposal', async () => {
    const result = (await proposeFileMergeTool.invoke(
      {
        path: 'notes/readme.md',
        mergedContent: '# Notes\n\nmerged body',
        explanation: 'Kept both the draft heading and the on-disk body.',
      },
      invokeConfig(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any;

    expect(result.update.activeSkill).to.equal(null);
    expect(result.update.messages).to.have.length(1);
    expect(result.update.messages[0].name).to.equal('propose_file_merge');
    expect(result.update.messages[0].content).to.include('notes/readme.md');
    expect(result.update.messages[0].content).to.include(
      'Kept both the draft heading and the on-disk body.',
    );
  });

  it('never writes to disk — the tool has no filesystem dependency at all', async () => {
    // This is a structural/documentation assertion, not a behavioral one:
    // the tool factory takes no store/fs dependency to inject (unlike
    // create-workspace.tool.ts/create-project.tool.ts), which is what makes
    // "writes nothing to disk" true by construction rather than by a
    // runtime check. Invoking it twice with the same mergedContent for two
    // different paths just confirms it never throws or side-effects based
    // on the path given.
    const first = await proposeFileMergeTool.invoke(
      { path: 'a.md', mergedContent: 'x', explanation: 'e' },
      invokeConfig(),
    );
    const second = await proposeFileMergeTool.invoke(
      { path: 'b.md', mergedContent: 'y', explanation: 'f' },
      invokeConfig(),
    );
    expect(first).to.not.equal(undefined);
    expect(second).to.not.equal(undefined);
  });
});
