import { describe, it } from 'mocha';
import { expect } from 'chai';
import { classifyShellCommand } from './shell-command-classifier.js';

describe('services/shell-command-classifier', () => {
  it('classifies a pure read command', () => {
    const result = classifyShellCommand('cat notes.txt');
    expect(result).to.deep.equal({ isFileRead: true, isFileWrite: false, isOther: false });
  });

  it('classifies a pure write command', () => {
    const result = classifyShellCommand("sed -i 's/x/y/' notes.txt");
    expect(result).to.deep.equal({ isFileRead: false, isFileWrite: true, isOther: false });
  });

  it('classifies output redirection as a write', () => {
    const result = classifyShellCommand('echo hello > notes.txt');
    expect(result).to.deep.equal({ isFileRead: false, isFileWrite: true, isOther: false });
  });

  it('classifies an unrecognized command as other', () => {
    const result = classifyShellCommand('npm test');
    expect(result).to.deep.equal({ isFileRead: false, isFileWrite: false, isOther: true });
  });

  it('sets both isFileRead and isFileWrite for a chained read+write command', () => {
    const result = classifyShellCommand("cat notes.txt && sed -i 's/x/y/' notes.txt");
    expect(result).to.deep.equal({ isFileRead: true, isFileWrite: true, isOther: false });
  });

  it('sets isOther alongside a real match, not just when nothing matches', () => {
    const result = classifyShellCommand('cat notes.txt && git commit -am "wip"');
    expect(result).to.deep.equal({ isFileRead: true, isFileWrite: false, isOther: true });
  });
});
