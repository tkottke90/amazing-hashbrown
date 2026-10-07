import { expect } from 'chai';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseRoundScores, computeRoundStats, writeBaselineEntry } from '../scripts/update-baseline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const YAML = createRequire(path.join(repoRoot, 'lib/evaluations/package.json'))('yaml');

describe('computeRoundStats', () => {
  it('computes mean/min/max/population-stdev for a known round-score set [unit]', () => {
    const stats = computeRoundStats([15, 16, 15, 17, 15]);
    expect(stats.score).to.equal(15.6);
    expect(stats.min).to.equal(15);
    expect(stats.max).to.equal(17);
    expect(stats.stdev).to.be.closeTo(0.8, 1e-9);
    expect(stats.rounds).to.equal(5);
  });

  it('returns stdev 0 and min === max === score for a single round [unit]', () => {
    const stats = computeRoundStats(parseRoundScores('15'));
    expect(stats).to.deep.equal({ score: 15, min: 15, max: 15, stdev: 0, rounds: 1 });
  });
});

describe('parseRoundScores', () => {
  it('rejects a missing or empty --round-scores value [unit]', () => {
    expect(() => parseRoundScores(undefined)).to.throw(/required/);
    expect(() => parseRoundScores('')).to.throw(/required/);
    expect(() => parseRoundScores('   ')).to.throw(/required/);
  });

  it('rejects a round-scores list with an empty element [unit]', () => {
    expect(() => parseRoundScores('15,,17')).to.throw(/empty value/);
  });

  it('rejects a round-scores list with a non-numeric element [unit]', () => {
    expect(() => parseRoundScores('15,abc,17')).to.throw(/non-numeric/);
  });

  it('parses a well-formed comma-separated list in order [unit]', () => {
    expect(parseRoundScores('15,16,15,17,15')).to.deep.equal([15, 16, 15, 17, 15]);
  });
});

describe('writeBaselineEntry', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'update-baseline-test-'));
    filePath = path.join(dir, 'eval-baselines.yaml');
    writeFileSync(
      filePath,
      [
        '# header comment line 1',
        '# header comment line 2',
        'baselines:',
        '  {',
        '    suite-a:',
        '      {',
        '        slug-a: { provider: p, model: m, judgeModel: j, score: 1, total: 1, rounds: 1, updatedAt: t, branch: b, commit: c },',
        '      },',
        '    suite-b:',
        '      {',
        '        slug-b: { provider: p, model: m, judgeModel: j, score: 2, total: 2, rounds: 2, updatedAt: t, branch: b, commit: c },',
        '      },',
        '  }',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes min/max/stdev into the targeted entry and reports the prior score [unit]', () => {
    const stats = computeRoundStats([15, 16, 15]);
    const { oldScore } = writeBaselineEntry({
      filePath,
      suiteId: 'suite-a',
      slug: 'slug-a',
      entry: {
        provider: 'np',
        model: 'nm',
        judgeModel: 'nj',
        score: stats.score,
        min: stats.min,
        max: stats.max,
        stdev: stats.stdev,
        total: 3,
        rounds: stats.rounds,
        updatedAt: 'nt',
        branch: 'nb',
        commit: 'nc',
      },
    });

    expect(oldScore).to.equal(1);

    const written = YAML.parse(readFileSync(filePath, 'utf8'));
    expect(written.baselines['suite-a']['slug-a']).to.deep.include({ min: 15, max: 16, rounds: 3 });
  });

  it('leaves every other (suite, slug) entry and the header comment untouched [unit]', () => {
    const stats = computeRoundStats([15, 16, 15]);
    writeBaselineEntry({
      filePath,
      suiteId: 'suite-a',
      slug: 'slug-new',
      entry: {
        provider: 'np',
        model: 'nm',
        judgeModel: 'nj',
        score: stats.score,
        min: stats.min,
        max: stats.max,
        stdev: stats.stdev,
        total: 3,
        rounds: stats.rounds,
        updatedAt: 'nt',
        branch: 'nb',
        commit: 'nc',
      },
    });

    const raw = readFileSync(filePath, 'utf8');
    expect(raw.startsWith('# header comment line 1\n# header comment line 2\n')).to.be.true;

    const written = YAML.parse(raw);
    expect(written.baselines['suite-a']['slug-a']).to.deep.equal({
      provider: 'p',
      model: 'm',
      judgeModel: 'j',
      score: 1,
      total: 1,
      rounds: 1,
      updatedAt: 't',
      branch: 'b',
      commit: 'c',
    });
    expect(written.baselines['suite-b']['slug-b']).to.deep.equal({
      provider: 'p',
      model: 'm',
      judgeModel: 'j',
      score: 2,
      total: 2,
      rounds: 2,
      updatedAt: 't',
      branch: 'b',
      commit: 'c',
    });
    expect(written.baselines['suite-a']['slug-new']).to.deep.include({ min: 15, max: 16 });
  });

  it('returns oldScore null when no prior entry exists for the key [unit]', () => {
    const stats = computeRoundStats([10]);
    const { oldScore } = writeBaselineEntry({
      filePath,
      suiteId: 'suite-c',
      slug: 'slug-c',
      entry: {
        provider: 'p',
        model: 'm',
        judgeModel: 'j',
        score: stats.score,
        min: stats.min,
        max: stats.max,
        stdev: stats.stdev,
        total: 1,
        rounds: stats.rounds,
        updatedAt: 't',
        branch: 'b',
        commit: 'c',
      },
    });
    expect(oldScore).to.be.null;
  });
});
