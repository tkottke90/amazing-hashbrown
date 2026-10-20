import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildArtifactIndex } from './artifact-index.js';

describe('agents/artifact-index', () => {
  it('returns an empty string when the skill has neither scripts nor references [unit]', () => {
    expect(buildArtifactIndex({}, {})).to.equal('');
  });

  it('lists references before scripts [unit]', () => {
    const result = buildArtifactIndex(
      { 'check.sh': '/path/check.sh' },
      { 'operations.md': '/path/operations.md' },
    );
    const referenceLine = result.indexOf('Reference `operations.md`');
    const scriptLine = result.indexOf('Script `check.sh`');
    expect(referenceLine).to.be.greaterThan(-1);
    expect(scriptLine).to.be.greaterThan(referenceLine);
  });

  it('sorts basenames alphabetically within each group [unit]', () => {
    const result = buildArtifactIndex(
      { 'z-script.sh': 'p1', 'a-script.py': 'p2' },
      { 'z-ref.md': 'p3', 'a-ref.md': 'p4' },
    );
    const aRef = result.indexOf('a-ref.md');
    const zRef = result.indexOf('z-ref.md');
    const aScript = result.indexOf('a-script.py');
    const zScript = result.indexOf('z-script.sh');
    expect(aRef).to.be.lessThan(zRef);
    expect(aScript).to.be.lessThan(zScript);
  });

  it('produces the exact documented format [unit]', () => {
    const result = buildArtifactIndex(
      { 'check-status.sh': 'p1' },
      { 'operations.md': 'p2' },
    );
    expect(result).to.equal(
      '## Available Artifacts\n' +
        '- Reference `operations.md` → call `read_skill_reference` with `name: "operations.md"`\n' +
        '- Script `check-status.sh` → call `run_skill_script` with `name: "check-status.sh"`',
    );
  });

  it('omits the scripts section header text when only references exist [unit]', () => {
    const result = buildArtifactIndex({}, { 'operations.md': 'p1' });
    expect(result).to.not.include('Script `');
    expect(result).to.include('Reference `operations.md`');
  });
});
