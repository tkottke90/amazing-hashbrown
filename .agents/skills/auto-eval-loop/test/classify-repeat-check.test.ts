import { expect } from 'chai';
import {
  classifyScenario,
  findProbeEntry,
  classifyRepeatCheck,
} from '../scripts/classify-repeat-check.mjs';

describe('classifyScenario', () => {
  it('classifies 2/3 fail as real [unit]', () => {
    expect(classifyScenario(['fail', 'pass', 'fail'])).to.equal('real');
  });

  it('classifies 3/3 fail as real [unit]', () => {
    expect(classifyScenario(['fail', 'fail', 'fail'])).to.equal('real');
  });

  it('classifies 0/3 fail as noise [unit]', () => {
    expect(classifyScenario(['pass', 'pass', 'pass'])).to.equal('noise');
  });

  it('classifies 1/3 fail as noise [unit]', () => {
    expect(classifyScenario(['fail', 'pass', 'pass'])).to.equal('noise');
  });

  it('classifies any error outcome as inconclusive regardless of fail count [unit]', () => {
    expect(classifyScenario(['error', 'pass', 'pass'])).to.equal('inconclusive');
  });

  it('classifies any missing outcome as inconclusive regardless of fail count [unit]', () => {
    expect(classifyScenario(['fail', 'fail', 'missing'])).to.equal('inconclusive');
  });
});

describe('findProbeEntry', () => {
  const probeJson = {
    entries: [
      { suiteId: 'wiki-navigation', model: 'ornith', status: 'analyzed', analysis: { scenarios: [] } },
      { suiteId: 'wiki-navigation', model: 'glm', status: 'analyzed', analysis: { scenarios: [] } },
      { suiteId: 'wiki-search', model: 'ornith', status: 'errored', reason: 'boom' },
    ],
  };

  it('locates the correct entry by (suiteId, model) among several [unit]', () => {
    const entry = findProbeEntry(probeJson, { suiteId: 'wiki-navigation', model: 'glm' });
    expect(entry.model).to.equal('glm');
  });

  it('throws a descriptive error when no entry matches [unit]', () => {
    expect(() => findProbeEntry(probeJson, { suiteId: 'wiki-navigation', model: 'nope' })).to.throw(
      /no probe entry found/,
    );
  });
});

describe('classifyRepeatCheck', () => {
  it('marks every requested scenario inconclusive when the whole entry errored [unit]', () => {
    const entry = { suiteId: 's', model: 'm', status: 'errored', reason: 'boom' };
    const results = classifyRepeatCheck(entry, ['a', 'b']);
    expect(results).to.deep.equal([
      { scenarioId: 'a', verdict: 'inconclusive' },
      { scenarioId: 'b', verdict: 'inconclusive' },
    ]);
  });

  it('classifies each scenario independently on an analyzed entry [unit]', () => {
    const entry = {
      suiteId: 's',
      model: 'm',
      status: 'analyzed',
      analysis: {
        scenarios: [
          { scenarioId: 'wnav-009', outcomes: ['fail', 'pass', 'fail'] },
          { scenarioId: 'wnav-004', outcomes: ['fail', 'pass', 'pass'] },
        ],
      },
    };
    const results = classifyRepeatCheck(entry, ['wnav-009', 'wnav-004']);
    expect(results).to.deep.equal([
      { scenarioId: 'wnav-009', outcomes: ['fail', 'pass', 'fail'], failCount: 2, verdict: 'real' },
      { scenarioId: 'wnav-004', outcomes: ['fail', 'pass', 'pass'], failCount: 1, verdict: 'noise' },
    ]);
  });

  it('throws a descriptive error naming available scenario IDs for an unknown scenario [unit]', () => {
    const entry = {
      suiteId: 's',
      model: 'm',
      status: 'analyzed',
      analysis: { scenarios: [{ scenarioId: 'wnav-004', outcomes: ['pass', 'pass', 'pass'] }] },
    };
    expect(() => classifyRepeatCheck(entry, ['wnav-999'])).to.throw(/wnav-999.*not found.*wnav-004/s);
  });
});
