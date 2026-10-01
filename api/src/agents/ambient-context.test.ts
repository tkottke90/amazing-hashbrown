import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildAmbientContext } from './ambient-context.js';

enum TestTypes {
  UNIT = '[unit]',
}

describe('agents/ambient-context', () => {
  describe('buildAmbientContext()', () => {
    it(`renders the current date/time resolved to the given timezone ${TestTypes.UNIT}`, () => {
      const result = buildAmbientContext({
        timezone: 'UTC',
        now: new Date('2026-09-26T17:05:00.000Z'),
      });

      expect(result).to.equal(
        'Current date and time: 2026-09-26 17:05 UTC. "Today," "tomorrow," and similar relative dates resolve against this.',
      );
    });

    it(`resolves "today" against the configured timezone, not UTC or host-local ${TestTypes.UNIT}`, () => {
      // 23:30 UTC on Oct 1 is still 16:30 on Oct 1 in America/Los_Angeles —
      // a UTC-only resolution would already say Oct 2 here, which is exactly
      // the mismatch issue #244's research found no surveyed harness avoids.
      const result = buildAmbientContext({
        timezone: 'America/Los_Angeles',
        now: new Date('2026-10-01T23:30:00.000Z'),
      });

      expect(result).to.include('2026-10-01 16:30 America/Los_Angeles');
    });

    it(`falls back to the real clock when "now" is omitted ${TestTypes.UNIT}`, () => {
      const result = buildAmbientContext({ timezone: 'UTC' });

      expect(result).to.match(/^Current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
    });
  });
});
