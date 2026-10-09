import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'mocha';
import {
  loadBaselineFile,
  findBaselineEntry,
  compareToBaseline,
  evaluateBaselineCheck,
  type BaselineEntry,
  type BaselineFile,
} from '../../src/baseline.js';

// Real entries lifted from this repo's own eval-baselines.yaml so the test
// data doubles as a sanity check on the shape that file actually contains.
const AFTER_AGENT_OLLAMA: BaselineEntry = {
  provider: 'local',
  model: 'GPT-OSS-20B',
  judgeModel: 'anthropic',
  score: 13.2,
  min: 13,
  max: 14,
  stdev: 0.39999999999999997,
  total: 18,
  rounds: 5,
  updatedAt: '2026-10-07T22:29:38.943Z',
  branch: 'main',
  commit: '379dbae62924c118ab167241a0588a20dec952aa',
};

// stdev: 0 case — every round landed on the same count, so the comparison
// should be strict: any deviation at all flags.
const AGENT_WAIT_OLLAMA: BaselineEntry = {
  provider: 'local',
  model: 'GPT-OSS-20B',
  judgeModel: 'anthropic',
  score: 4,
  min: 4,
  max: 4,
  stdev: 0,
  total: 5,
  rounds: 5,
  updatedAt: '2026-10-07T22:29:38.943Z',
  branch: 'main',
  commit: '379dbae62924c118ab167241a0588a20dec952aa',
};

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'eval-baseline-test-'));
}

describe('compareToBaseline', () => {
  it('returns WITHIN_BASELINE when the current score is inside score ± stdev [unit]', () => {
    const result = compareToBaseline({ score: 13, total: 18 }, AFTER_AGENT_OLLAMA);
    assert.equal(result.stale, false);
    assert.equal(!result.stale && result.verdict, 'WITHIN_BASELINE');
  });

  it('returns REGRESSION when the current score is below score - stdev [unit]', () => {
    const result = compareToBaseline({ score: 12, total: 18 }, AFTER_AGENT_OLLAMA);
    assert.equal(result.stale, false);
    assert.equal(!result.stale && result.verdict, 'REGRESSION');
  });

  it('returns IMPROVEMENT when the current score is above score + stdev [unit]', () => {
    const result = compareToBaseline({ score: 19, total: 18 }, AFTER_AGENT_OLLAMA);
    assert.equal(result.stale, false);
    assert.equal(!result.stale && result.verdict, 'IMPROVEMENT');
    assert.ok(!result.stale && Math.abs(result.delta - 5.8) < 1e-9);
  });

  it('flags REGRESSION for any drop below a stdev: 0 baseline [unit]', () => {
    const result = compareToBaseline({ score: 3, total: 5 }, AGENT_WAIT_OLLAMA);
    assert.equal(result.stale, false);
    assert.equal(!result.stale && result.verdict, 'REGRESSION');
  });

  it('flags IMPROVEMENT for any rise above a stdev: 0 baseline [unit]', () => {
    const result = compareToBaseline({ score: 5, total: 5 }, AGENT_WAIT_OLLAMA);
    assert.equal(result.stale, false);
    assert.equal(!result.stale && result.verdict, 'IMPROVEMENT');
  });

  it('returns WITHIN_BASELINE for an exact match against a stdev: 0 baseline [unit]', () => {
    const result = compareToBaseline({ score: 4, total: 5 }, AGENT_WAIT_OLLAMA);
    assert.equal(result.stale, false);
    assert.equal(!result.stale && result.verdict, 'WITHIN_BASELINE');
  });

  it('returns stale: true when current.total does not match entry.total, regardless of score [unit]', () => {
    const result = compareToBaseline({ score: 12, total: 17 }, AFTER_AGENT_OLLAMA);
    assert.equal(result.stale, true);
  });
});

describe('findBaselineEntry', () => {
  const file: BaselineFile = {
    'after-agent': {
      'ollama-gptoss20b': AFTER_AGENT_OLLAMA,
    },
    'agent-wait': {
      'ollama-gptoss20b': AGENT_WAIT_OLLAMA,
    },
    // Synthetic fixture for the ambiguous case — two slugs under one suite
    // sharing the same provider (no real suite in eval-baselines.yaml
    // happens to collide like this today).
    'ambiguous-suite': {
      'slug-a': AFTER_AGENT_OLLAMA,
      'slug-b': AFTER_AGENT_OLLAMA,
    },
  };

  it('auto-matches the one entry whose provider equals the given provider [unit]', () => {
    const result = findBaselineEntry(file, 'after-agent', { provider: 'local' });
    assert.ok(!('error' in result));
    assert.equal(!('error' in result) && result.slug, 'ollama-gptoss20b');
  });

  it('returns not_found when no entry matches the given provider [unit]', () => {
    const result = findBaselineEntry(file, 'after-agent', { provider: 'does-not-exist' });
    assert.ok('error' in result);
    assert.equal('error' in result && result.error, 'not_found');
  });

  it('returns not_found when the suite id has no entries at all [unit]', () => {
    const result = findBaselineEntry(file, 'no-such-suite', { provider: 'local' });
    assert.ok('error' in result);
    assert.equal('error' in result && result.error, 'not_found');
  });

  it('returns ambiguous with every matching slug when more than one entry shares a provider [unit]', () => {
    const result = findBaselineEntry(file, 'ambiguous-suite', { provider: 'local' });
    assert.ok('error' in result);
    assert.equal('error' in result && result.error, 'ambiguous');
    assert.deepEqual('error' in result ? [...result.candidates].sort() : [], ['slug-a', 'slug-b']);
  });

  it('an explicit slug bypasses provider matching entirely [unit]', () => {
    const result = findBaselineEntry(file, 'after-agent', {
      provider: 'some-unrelated-provider',
      slug: 'ollama-gptoss20b',
    });
    assert.ok(!('error' in result));
    assert.equal(!('error' in result) && result.entry, AFTER_AGENT_OLLAMA);
  });

  it('returns not_found when an explicit slug does not exist under that suite [unit]', () => {
    const result = findBaselineEntry(file, 'after-agent', {
      provider: 'local',
      slug: 'does-not-exist',
    });
    assert.ok('error' in result);
    assert.equal('error' in result && result.error, 'not_found');
  });
});

describe('loadBaselineFile', () => {
  it('loads and validates a well-formed baseline file [unit]', () => {
    const dir = createTempDir();
    try {
      const filePath = join(dir, 'eval-baselines.yaml');
      writeFileSync(
        filePath,
        `baselines:
  after-agent:
    ollama-gptoss20b:
      provider: local
      model: GPT-OSS-20B
      judgeModel: anthropic
      score: 13.2
      min: 13
      max: 14
      stdev: 0.4
      total: 18
      rounds: 5
      updatedAt: 2026-10-07T22:29:38.943Z
      branch: main
      commit: 379dbae62924c118ab167241a0588a20dec952aa
`,
      );
      const result = loadBaselineFile(filePath);
      assert.equal(result['after-agent']?.['ollama-gptoss20b']?.score, 13.2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a descriptive error naming the suite/slug for an entry missing a required field [unit]', () => {
    const dir = createTempDir();
    try {
      const filePath = join(dir, 'eval-baselines.yaml');
      writeFileSync(
        filePath,
        `baselines:
  after-agent:
    ollama-gptoss20b:
      provider: local
      model: GPT-OSS-20B
      judgeModel: anthropic
      score: 13.2
      min: 13
      max: 14
      total: 18
      rounds: 5
      updatedAt: 2026-10-07T22:29:38.943Z
      branch: main
      commit: 379dbae62924c118ab167241a0588a20dec952aa
`,
      );
      assert.throws(() => loadBaselineFile(filePath), /after-agent.*ollama-gptoss20b/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a descriptive error for unparseable YAML content [unit]', () => {
    const dir = createTempDir();
    try {
      const filePath = join(dir, 'eval-baselines.yaml');
      writeFileSync(filePath, 'baselines: [unclosed bracket');
      assert.throws(() => loadBaselineFile(filePath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// evaluateBaselineCheck is the full --check-baseline decision bin/eval.ts
// delegates to — resolution + comparison + every message/record it prints
// or persists. Since all of that is deterministic given a baseline file and
// a current score, each case below asserts the exact output, not just a
// verdict string, per the point of pulling this out of bin/eval.ts: nothing
// about what gets printed or written to the result YAML should need a real
// eval run to verify.
describe('evaluateBaselineCheck', () => {
  const file: BaselineFile = {
    'after-agent': {
      'ollama-gptoss20b': AFTER_AGENT_OLLAMA,
    },
    'agent-wait': {
      'ollama-gptoss20b': AGENT_WAIT_OLLAMA,
    },
    'ambiguous-suite': {
      'slug-a': AFTER_AGENT_OLLAMA,
      'slug-b': AFTER_AGENT_OLLAMA,
    },
  };

  it('returns an "ok" result with the exact record and console lines for WITHIN_BASELINE [unit]', () => {
    const current = { score: 13, total: 18 };
    const result = evaluateBaselineCheck(file, 'after-agent', current, { provider: 'local' });

    if (result.type !== 'ok') throw new Error(`expected "ok", got "${result.type}"`);
    assert.deepEqual(result.record, {
      slug: 'ollama-gptoss20b',
      provider: 'local',
      judgeModel: 'anthropic',
      baselineScore: AFTER_AGENT_OLLAMA.score,
      baselineStdev: AFTER_AGENT_OLLAMA.stdev,
      baselineMin: AFTER_AGENT_OLLAMA.min,
      baselineMax: AFTER_AGENT_OLLAMA.max,
      baselineTotal: AFTER_AGENT_OLLAMA.total,
      currentScore: 13,
      delta: current.score - AFTER_AGENT_OLLAMA.score,
      verdict: 'WITHIN_BASELINE',
    });
    assert.deepEqual(result.consoleLines, [
      '[baseline] after-agent / ollama-gptoss20b',
      '  Current:   13  (this run)',
      '  Baseline:  13.2 ± 0.39999999999999997  (mean ± stdev, n=5, min 13 / max 14)',
      '  Verdict:   WITHIN_BASELINE',
    ]);
  });

  it('returns an "ok" result with verdict REGRESSION and the correct (negative) delta [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'after-agent',
      { score: 12, total: 18 },
      {
        provider: 'local',
      },
    );
    if (result.type !== 'ok') throw new Error(`expected "ok", got "${result.type}"`);
    assert.equal(result.record.verdict, 'REGRESSION');
    assert.ok(Math.abs(result.record.delta - (12 - AFTER_AGENT_OLLAMA.score)) < 1e-9);
    assert.equal(result.consoleLines.at(-1), '  Verdict:   REGRESSION');
  });

  it('returns an "ok" result with verdict IMPROVEMENT and the correct (positive) delta [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'after-agent',
      { score: 19, total: 18 },
      {
        provider: 'local',
      },
    );
    if (result.type !== 'ok') throw new Error(`expected "ok", got "${result.type}"`);
    assert.equal(result.record.verdict, 'IMPROVEMENT');
    assert.ok(Math.abs(result.record.delta - (19 - AFTER_AGENT_OLLAMA.score)) < 1e-9);
  });

  it('strictly regresses a stdev: 0 baseline on any drop [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'agent-wait',
      { score: 3, total: 5 },
      {
        provider: 'local',
      },
    );
    if (result.type !== 'ok') throw new Error(`expected "ok", got "${result.type}"`);
    assert.equal(result.record.verdict, 'REGRESSION');
  });

  it('respects an explicit slug, bypassing provider matching entirely [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'after-agent',
      { score: 13, total: 18 },
      { provider: 'some-unrelated-provider', slug: 'ollama-gptoss20b' },
    );
    if (result.type !== 'ok') throw new Error(`expected "ok", got "${result.type}"`);
    assert.equal(result.slug, 'ollama-gptoss20b');
  });

  it('returns a "not_found" result naming the suite and provider when nothing matches [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'after-agent',
      { score: 13, total: 18 },
      {
        provider: 'does-not-exist',
      },
    );
    assert.deepEqual(result, {
      type: 'not_found',
      message: 'no baseline on file for suite "after-agent", provider "does-not-exist"',
    });
  });

  it('returns an "ambiguous" result listing every candidate slug and its model [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'ambiguous-suite',
      { score: 13, total: 18 },
      { provider: 'local' },
    );
    if (result.type !== 'ambiguous') throw new Error(`expected "ambiguous", got "${result.type}"`);
    assert.deepEqual([...result.candidates].sort(), ['slug-a', 'slug-b']);
    assert.match(result.message, /ambiguous baseline for suite "ambiguous-suite"/);
    assert.match(result.message, /slug-a \(model: GPT-OSS-20B\)/);
    assert.match(result.message, /slug-b \(model: GPT-OSS-20B\)/);
    assert.match(result.message, /--baseline-slug/);
  });

  it('returns a "stale" result naming both totals when the scenario count has drifted [unit]', () => {
    const result = evaluateBaselineCheck(
      file,
      'after-agent',
      { score: 12, total: 17 },
      {
        provider: 'local',
      },
    );
    assert.deepEqual(result, {
      type: 'stale',
      message:
        'baseline for "after-agent"/"ollama-gptoss20b" was recorded against 18 scenarios, this run scored 17 — re-run /auto-update-baseline',
    });
  });
});
