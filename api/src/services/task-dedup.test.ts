import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  findDuplicateTask,
  normalizeSignatureText,
  shareDuplicateSignature,
  shareMatchingTimeSlot,
  type DedupCandidate,
} from './task-dedup.js';
import type { CronOnceConfig, CronRepeatConfig } from './cron-config.js';

enum TestTypes {
  UNIT = '[unit]',
}

function candidate(overrides: Partial<DedupCandidate> = {}): DedupCandidate {
  return {
    title: 'One-off Scheduler trigger test',
    description: null,
    trackerId: null,
    triggerType: 'cron_once',
    triggerConfig: cronOnce(),
    ...overrides,
  };
}

function cronOnce(overrides: Partial<CronOnceConfig> = {}): CronOnceConfig {
  return {
    fireAt: '2026-11-06T13:05:00.000Z',
    timezone: 'UTC',
    enabled: true,
    enabledAt: '2026-11-06T12:00:00.000Z',
    lastFiredAt: null,
    ...overrides,
  };
}

function cronRepeat(overrides: Partial<CronRepeatConfig> = {}): CronRepeatConfig {
  return {
    expression: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    maxIterations: null,
    stopAfter: null,
    maxConsecutiveFailures: 3,
    enabledAt: '2026-11-06T12:00:00.000Z',
    lastFiredAt: null,
    consecutiveFailures: 0,
    pausedReason: null,
    ...overrides,
  };
}

describe('normalizeSignatureText', () => {
  it(`collapses case and surrounding whitespace ${TestTypes.UNIT}`, () => {
    expect(normalizeSignatureText('  One-off  Scheduler Test  ')).to.equal(
      'one-off scheduler test',
    );
  });

  it(`collapses internal whitespace runs to a single space ${TestTypes.UNIT}`, () => {
    expect(normalizeSignatureText('a\t\tb\n\nc')).to.equal('a b c');
  });

  it(`reads null as an empty string ${TestTypes.UNIT}`, () => {
    expect(normalizeSignatureText(null)).to.equal('');
  });

  it(`reads undefined as an empty string ${TestTypes.UNIT}`, () => {
    expect(normalizeSignatureText(undefined)).to.equal('');
  });
});

describe('shareDuplicateSignature', () => {
  it(`matches identical title and description ${TestTypes.UNIT}`, () => {
    expect(
      shareDuplicateSignature(
        candidate({ title: 'Verify', description: 'check it' }),
        candidate({ title: 'Verify', description: 'check it' }),
      ),
    ).to.equal(true);
  });

  it(`matches despite case and whitespace differences ${TestTypes.UNIT}`, () => {
    expect(
      shareDuplicateSignature(
        candidate({ title: 'Verify Thing', description: null }),
        candidate({ title: '  verify   thing  ', description: null }),
      ),
    ).to.equal(true);
  });

  it(`treats a null description and an empty-string description as equal ${TestTypes.UNIT}`, () => {
    expect(
      shareDuplicateSignature(
        candidate({ title: 'Verify', description: null }),
        candidate({ title: 'Verify', description: '   ' }),
      ),
    ).to.equal(true);
  });

  it(`does not match differing titles ${TestTypes.UNIT}`, () => {
    expect(
      shareDuplicateSignature(candidate({ title: 'Verify A' }), candidate({ title: 'Verify B' })),
    ).to.equal(false);
  });

  it(`does not match differing descriptions ${TestTypes.UNIT}`, () => {
    expect(
      shareDuplicateSignature(
        candidate({ title: 'Verify', description: 'one' }),
        candidate({ title: 'Verify', description: 'two' }),
      ),
    ).to.equal(false);
  });
});

describe('shareMatchingTimeSlot', () => {
  it(`matches two cron_once fireAt values within tolerance ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerConfig: cronOnce({ fireAt: '2026-11-06T13:04:16.000Z' }) });
    const b = candidate({ triggerConfig: cronOnce({ fireAt: '2026-11-06T13:05:32.000Z' }) });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(true);
  });

  it(`matches at exactly the tolerance boundary ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerConfig: cronOnce({ fireAt: '2026-11-06T13:00:00.000Z' }) });
    const b = candidate({ triggerConfig: cronOnce({ fireAt: '2026-11-06T13:10:00.000Z' }) });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(true);
  });

  it(`does not match just outside the tolerance boundary ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerConfig: cronOnce({ fireAt: '2026-11-06T13:00:00.000Z' }) });
    const b = candidate({ triggerConfig: cronOnce({ fireAt: '2026-11-06T13:10:00.001Z' }) });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(false);
  });

  it(`matches two cron_repeat tasks with identical expression and timezone ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerType: 'cron_repeat', triggerConfig: cronRepeat() });
    const b = candidate({ triggerType: 'cron_repeat', triggerConfig: cronRepeat() });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(true);
  });

  it(`does not match two cron_repeat tasks with a different expression ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerType: 'cron_repeat', triggerConfig: cronRepeat() });
    const b = candidate({
      triggerType: 'cron_repeat',
      triggerConfig: cronRepeat({ expression: '0 10 * * *' }),
    });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(false);
  });

  it(`does not match two cron_repeat tasks with a different timezone ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerType: 'cron_repeat', triggerConfig: cronRepeat() });
    const b = candidate({
      triggerType: 'cron_repeat',
      triggerConfig: cronRepeat({ timezone: 'America/Chicago' }),
    });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(false);
  });

  it(`never matches a cron_once task against a cron_repeat task ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerType: 'cron_once', triggerConfig: cronOnce() });
    const b = candidate({ triggerType: 'cron_repeat', triggerConfig: cronRepeat() });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(false);
  });

  it(`does not match a plain chat-triggered task against a cron_once task ${TestTypes.UNIT}`, () => {
    const a = candidate({ triggerType: 'cron_once', triggerConfig: cronOnce() });
    const b = candidate({ triggerType: 'chat', triggerConfig: null });
    expect(shareMatchingTimeSlot(a, b, 10)).to.equal(false);
  });
});

describe('findDuplicateTask', () => {
  it(`returns the matching candidate when signature, time slot, and trackerId all match ${TestTypes.UNIT}`, () => {
    const existing = candidate({ trackerId: null });
    const result = findDuplicateTask([existing], candidate({ trackerId: null }), 10);
    expect(result).to.equal(existing);
  });

  it(`returns undefined when trackerId differs despite matching signature and time slot ${TestTypes.UNIT}`, () => {
    const existing = candidate({ trackerId: 'issue-1' });
    const result = findDuplicateTask([existing], candidate({ trackerId: 'issue-2' }), 10);
    expect(result).to.equal(undefined);
  });

  it(`treats two null trackerIds as equal ${TestTypes.UNIT}`, () => {
    const existing = candidate({ trackerId: null });
    const result = findDuplicateTask([existing], candidate({ trackerId: null }), 10);
    expect(result).to.not.equal(undefined);
  });

  it(`returns undefined when the input task is not cron-eligible ${TestTypes.UNIT}`, () => {
    const existing = candidate();
    const result = findDuplicateTask(
      [existing],
      candidate({ triggerType: 'chat', triggerConfig: null }),
      10,
    );
    expect(result).to.equal(undefined);
  });

  it(`returns undefined when no candidate matches ${TestTypes.UNIT}`, () => {
    const existing = candidate({ title: 'Something else entirely' });
    const result = findDuplicateTask([existing], candidate(), 10);
    expect(result).to.equal(undefined);
  });

  it(`returns the first matching candidate in list order ${TestTypes.UNIT}`, () => {
    const first = candidate();
    const second = candidate();
    const result = findDuplicateTask([first, second], candidate(), 10);
    expect(result).to.equal(first);
  });
});
