import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  cronExpressionError,
  describeSchedule,
  isValidTimeZone,
  latestMissedFireAt,
  nextFireAt,
  type CronOnceTiming,
  type CronRepeatTiming,
} from './cron-schedule.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function repeat(overrides: Partial<CronRepeatTiming> = {}): CronRepeatTiming {
  return {
    kind: 'cron_repeat',
    expression: '0 0 * * *',
    timezone: 'UTC',
    enabledAt: '2026-01-01T00:00:00.000Z',
    lastFiredAt: null,
    maxIterations: null,
    stopAfter: null,
    ...overrides,
  };
}

function once(overrides: Partial<CronOnceTiming> = {}): CronOnceTiming {
  return {
    kind: 'cron_once',
    fireAt: '2026-10-01T15:00:00.000Z',
    enabledAt: '2026-09-01T00:00:00.000Z',
    lastFiredAt: null,
    ...overrides,
  };
}

describe('services/cron-schedule', () => {
  describe('cronExpressionError()', () => {
    it('accepts a standard 5-field expression [unit]', () => {
      expect(cronExpressionError('*/15 9-17 * * 1-5', 'UTC')).to.equal(null);
    });

    it('rejects a seconds field or a padded short form, which the parser would otherwise accept [unit]', () => {
      expect(cronExpressionError('0 0 0 * * *', 'UTC')).to.match(/5-field form/);
      expect(cronExpressionError('* * *', 'UTC')).to.match(/got 3 fields/);
    });

    it('rejects an out-of-range value with the parser message [unit]', () => {
      expect(cronExpressionError('61 * * * *', 'UTC')).to.match(/0-59/);
    });

    it('rejects an unknown time zone up front, instead of at first fire [unit]', () => {
      expect(isValidTimeZone('America/Chicago')).to.equal(true);
      expect(cronExpressionError('0 0 * * *', 'Nowhere/Land')).to.equal(
        'Unknown time zone "Nowhere/Land".',
      );
    });
  });

  describe('nextFireAt() — cron_repeat', () => {
    it('fires at midnight in the task time zone, not the server zone [unit]', () => {
      const next = nextFireAt(
        repeat({ timezone: 'America/Chicago' }),
        new Date('2026-09-26T12:00:00Z'),
        0,
      );
      expect(iso(next)).to.equal('2026-09-27T05:00:00.000Z'); // 00:00 CDT
    });

    it('is strictly after the given time, so a fire at "now" is not returned again [unit]', () => {
      const next = nextFireAt(repeat(), new Date('2026-09-27T00:00:00Z'), 0);
      expect(iso(next)).to.equal('2026-09-28T00:00:00.000Z');
    });

    it('does not skip the day when spring-forward removes the scheduled hour [unit]', () => {
      // 02:30 does not exist in Chicago on 2026-03-08; it fires at 03:30 CDT.
      const next = nextFireAt(
        repeat({ expression: '30 2 * * *', timezone: 'America/Chicago' }),
        new Date('2026-03-07T12:00:00Z'),
        0,
      );
      expect(iso(next)).to.equal('2026-03-08T08:30:00.000Z');
    });

    it('fires once, not twice, when fall-back repeats the scheduled hour [unit]', () => {
      const timing = repeat({ expression: '30 1 * * *', timezone: 'America/Chicago' });
      const first = nextFireAt(timing, new Date('2026-10-31T12:00:00Z'), 0)!;
      const second = nextFireAt(timing, first, 1)!;
      expect(iso(first)).to.equal('2026-11-01T06:30:00.000Z'); // 01:30 CDT
      expect(iso(second)).to.equal('2026-11-02T07:30:00.000Z'); // next day, 01:30 CST
    });

    it('stops once maxIterations scheduled runs have happened [unit]', () => {
      const timing = repeat({ maxIterations: 3 });
      expect(nextFireAt(timing, new Date('2026-09-26T12:00:00Z'), 2)).to.not.equal(null);
      expect(nextFireAt(timing, new Date('2026-09-26T12:00:00Z'), 3)).to.equal(null);
    });

    it('stops when the next fire would land after stopAfter [unit]', () => {
      const timing = repeat({ stopAfter: '2026-09-27T12:00:00.000Z' });
      expect(iso(nextFireAt(timing, new Date('2026-09-26T12:00:00Z'), 0))).to.equal(
        '2026-09-27T00:00:00.000Z',
      );
      expect(nextFireAt(timing, new Date('2026-09-27T00:00:00Z'), 1)).to.equal(null);
    });
  });

  describe('nextFireAt() — cron_once', () => {
    it('returns the fire time while it is still ahead, and never again after [unit]', () => {
      expect(iso(nextFireAt(once(), new Date('2026-09-30T00:00:00Z'), 0))).to.equal(
        '2026-10-01T15:00:00.000Z',
      );
      expect(nextFireAt(once(), new Date('2026-10-01T15:00:00Z'), 0)).to.equal(null);
    });
  });

  describe('latestMissedFireAt() — catch-up after downtime', () => {
    it('returns one time — the latest — even when many fire times were missed [unit]', () => {
      const timing = repeat({ lastFiredAt: '2026-09-20T00:00:00.000Z' });
      expect(iso(latestMissedFireAt(timing, new Date('2026-09-26T10:00:00Z'), 5))).to.equal(
        '2026-09-26T00:00:00.000Z',
      );
    });

    it('returns nothing when no fire time came due since the last fire [unit]', () => {
      const timing = repeat({ lastFiredAt: '2026-09-26T00:00:00.000Z' });
      expect(latestMissedFireAt(timing, new Date('2026-09-26T10:00:00Z'), 5)).to.equal(null);
    });

    it('counts a fire time exactly at "now" as due [unit]', () => {
      const timing = repeat({ lastFiredAt: '2026-09-25T00:00:00.000Z' });
      expect(iso(latestMissedFireAt(timing, new Date('2026-09-26T00:00:00Z'), 1))).to.equal(
        '2026-09-26T00:00:00.000Z',
      );
    });

    it('never catches up fire times from before the schedule was (re-)enabled [unit]', () => {
      const timing = repeat({
        lastFiredAt: '2026-09-01T00:00:00.000Z',
        enabledAt: '2026-09-26T08:00:00.000Z',
      });
      expect(latestMissedFireAt(timing, new Date('2026-09-26T10:00:00Z'), 1)).to.equal(null);
    });

    it('does not catch up past stopAfter or an exhausted budget [unit]', () => {
      const now = new Date('2026-09-26T10:00:00Z');
      expect(
        latestMissedFireAt(repeat({ stopAfter: '2026-09-20T00:00:00.000Z' }), now, 0),
      ).to.equal(null);
      expect(latestMissedFireAt(repeat({ maxIterations: 2 }), now, 2)).to.equal(null);
    });

    it('fires a cron_once late if its time passed while the server was down [unit]', () => {
      expect(iso(latestMissedFireAt(once(), new Date('2026-10-02T00:00:00Z'), 0))).to.equal(
        '2026-10-01T15:00:00.000Z',
      );
    });

    it('never fires a cron_once twice, or for a time set before it was enabled [unit]', () => {
      const now = new Date('2026-10-02T00:00:00Z');
      expect(
        latestMissedFireAt(once({ lastFiredAt: '2026-10-01T15:00:00.000Z' }), now, 1),
      ).to.equal(null);
      expect(latestMissedFireAt(once({ enabledAt: '2026-10-01T16:00:00.000Z' }), now, 0)).to.equal(
        null,
      );
    });
  });

  describe('describeSchedule()', () => {
    it('reads the expression back in words and lists the next three fire times [unit]', () => {
      const result = describeSchedule(repeat(), new Date('2026-09-26T12:00:00Z'));
      expect(result.description).to.equal('At 12:00 AM');
      expect(result.nextFireTimes.map(iso)).to.deep.equal([
        '2026-09-27T00:00:00.000Z',
        '2026-09-28T00:00:00.000Z',
        '2026-09-29T00:00:00.000Z',
      ]);
    });

    it('lists only the fire times left in the iteration budget [unit]', () => {
      const result = describeSchedule(
        repeat({ maxIterations: 5 }),
        new Date('2026-09-26T12:00:00Z'),
        4,
      );
      expect(result.nextFireTimes).to.have.length(1);
    });
  });
});
