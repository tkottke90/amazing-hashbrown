import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  cronExpressionError,
  describeLapsedFires,
  describeSchedule,
  isValidTimeZone,
  lapsedFiresToday,
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

  describe('lapsedFiresToday() — fire times already passed today, before enablement', () => {
    it('returns nothing when no match has happened yet today [unit]', () => {
      const timing = repeat({ expression: '0 6,11,14 * * *' });
      expect(lapsedFiresToday(timing, new Date('2026-09-26T05:30:00Z'))).to.deep.equal([]);
    });

    it('collects every match between local midnight and now, oldest first [unit]', () => {
      // Created at 14:10 Chicago time: all three of today's named times
      // (06:00, 11:00, 14:00) have already passed, not just the first two.
      const timing = repeat({ expression: '0 6,11,14 * * *', timezone: 'America/Chicago' });
      const result = lapsedFiresToday(timing, new Date('2026-09-26T19:10:00Z')); // 14:10 CDT
      expect(result.map(iso)).to.deep.equal([
        '2026-09-26T11:00:00.000Z', // 06:00 CDT
        '2026-09-26T16:00:00.000Z', // 11:00 CDT
        '2026-09-26T19:00:00.000Z', // 14:00 CDT
      ]);
    });

    it('treats a fire time exactly at "now" as lapsed, not yet-to-fire [unit]', () => {
      const timing = repeat({ expression: '0 6,11,14 * * *' });
      const result = lapsedFiresToday(timing, new Date('2026-09-26T11:00:00Z'));
      expect(result.map(iso)).to.deep.equal([
        '2026-09-26T06:00:00.000Z',
        '2026-09-26T11:00:00.000Z',
      ]);
    });

    it('uses the schedule\'s own time zone for "today", not UTC — a zone west of UTC [unit]', () => {
      // 18:00 PDT on Sept 26 is already Sept 27 in UTC, but it's still
      // "today" (Sept 26) where the schedule lives, and still gets reported.
      const timing = repeat({ expression: '0 6,18 * * *', timezone: 'America/Los_Angeles' });
      const result = lapsedFiresToday(timing, new Date('2026-09-27T03:00:00Z')); // 20:00 PDT Sept 26
      expect(result.map(iso)).to.deep.equal([
        '2026-09-26T13:00:00.000Z', // 06:00 PDT Sept 26
        '2026-09-27T01:00:00.000Z', // 18:00 PDT Sept 26
      ]);
    });

    it('uses the schedule\'s own time zone for "today" — a zone east of UTC [unit]', () => {
      // 06:00 JST on Sept 26 is still Sept 25 in UTC, but it's "today"
      // (Sept 26) in Tokyo, where the schedule lives.
      const timing = repeat({ expression: '0 6 * * *', timezone: 'Asia/Tokyo' });
      const result = lapsedFiresToday(timing, new Date('2026-09-26T00:30:00Z')); // 09:30 JST Sept 26
      expect(result.map(iso)).to.deep.equal(['2026-09-25T21:00:00.000Z']); // 06:00 JST Sept 26
    });

    it('stops at local midnight even when a DST transition happens later the same day [unit]', () => {
      // Nov 1 2026: Chicago falls back from CDT to CST between 1am and 2am.
      // Midnight (still CDT) and noon (already CST) are both "today."
      const timing = repeat({ expression: '0 0,12 * * *', timezone: 'America/Chicago' });
      const result = lapsedFiresToday(timing, new Date('2026-11-01T18:30:00Z')); // 12:30 CST
      expect(result.map(iso)).to.deep.equal([
        '2026-11-01T05:00:00.000Z', // 00:00 CDT
        '2026-11-01T18:00:00.000Z', // 12:00 CST
      ]);
    });

    it('handles a high-frequency expression across nearly a full day without hanging [unit]', () => {
      const timing = repeat({ expression: '* * * * *' });
      const result = lapsedFiresToday(timing, new Date('2026-09-26T23:59:00Z'));
      expect(result).to.have.length(1440);
      expect(iso(result[0]!)).to.equal('2026-09-26T00:00:00.000Z');
      expect(iso(result[result.length - 1]!)).to.equal('2026-09-26T23:59:00.000Z');
    });
  });

  describe('describeLapsedFires()', () => {
    it('returns undefined when there is nothing to warn about [unit]', () => {
      expect(describeLapsedFires([], 'UTC')).to.equal(undefined);
    });

    it('names a single lapsed time, singular [unit]', () => {
      const result = describeLapsedFires([new Date('2026-09-26T06:00:00Z')], 'UTC');
      expect(result).to.equal(
        "Heads up: today's 06:00 run already passed and won't fire. The schedule will run " +
          'normally starting with its next fire time.',
      );
    });

    it('joins two lapsed times with "and", plural [unit]', () => {
      const result = describeLapsedFires(
        [new Date('2026-09-26T06:00:00Z'), new Date('2026-09-26T11:00:00Z')],
        'UTC',
      );
      expect(result).to.equal(
        "Heads up: today's 06:00 and 11:00 runs already passed and won't fire. The schedule " +
          'will run normally starting with its next fire time.',
      );
    });

    it('lists up to 5 times with no overflow suffix [unit]', () => {
      const lapsed = ['06:00', '07:00', '08:00', '09:00', '10:00'].map(
        (t) => new Date(`2026-09-26T${t}:00Z`),
      );
      const result = describeLapsedFires(lapsed, 'UTC');
      expect(result).to.equal(
        "Heads up: today's 06:00, 07:00, 08:00, 09:00 and 10:00 runs already passed and " +
          "won't fire. The schedule will run normally starting with its next fire time.",
      );
    });

    it('caps at 5 named times and appends a "+N more" tail beyond that [unit]', () => {
      const lapsed = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00'].map(
        (t) => new Date(`2026-09-26T${t}:00Z`),
      );
      const result = describeLapsedFires(lapsed, 'UTC');
      expect(result).to.equal(
        "Heads up: today's 06:00, 07:00, 08:00, 09:00, 10:00, +3 more runs already passed " +
          "and won't fire. The schedule will run normally starting with its next fire time.",
      );
    });
  });
});
