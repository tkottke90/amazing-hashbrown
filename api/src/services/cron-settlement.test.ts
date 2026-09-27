import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { CronOnceConfig, CronRepeatConfig } from './cron-config.js';
import { settleCronRun } from './cron-settlement.js';

const NOW = new Date('2026-09-26T00:05:00.000Z');

function repeat(overrides: Partial<CronRepeatConfig> = {}): CronRepeatConfig {
  return {
    expression: '0 0 * * *',
    timezone: 'UTC',
    enabled: true,
    maxIterations: null,
    stopAfter: null,
    maxConsecutiveFailures: 3,
    enabledAt: '2026-09-01T00:00:00.000Z',
    lastFiredAt: '2026-09-26T00:00:00.000Z',
    consecutiveFailures: 0,
    pausedReason: null,
    ...overrides,
  };
}

function once(overrides: Partial<CronOnceConfig> = {}): CronOnceConfig {
  return {
    fireAt: '2026-09-26T00:00:00.000Z',
    timezone: 'UTC',
    enabled: true,
    enabledAt: '2026-09-01T00:00:00.000Z',
    lastFiredAt: '2026-09-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('services/cron-settlement — settleCronRun()', () => {
  describe('cron_repeat, runs the schedule started', () => {
    it("goes back to 'scheduled' after a successful run and resets the failure streak [unit]", () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 2 }),
        source: 'schedule',
        outcome: 'done',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('scheduled');
      expect((result.config as CronRepeatConfig).consecutiveFailures).to.equal(0);
    });

    it("stays 'scheduled' after a failure, counting it toward auto-pause [unit]", () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 1 }),
        source: 'catch_up',
        outcome: 'failed',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('scheduled');
      expect((result.config as CronRepeatConfig).consecutiveFailures).to.equal(2);
    });

    it('turns the schedule off at maxConsecutiveFailures so a broken job stops burning runs [unit]', () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 2 }),
        source: 'schedule',
        outcome: 'failed',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('pending');
      expect(result.config).to.include({
        enabled: false,
        pausedReason: 'consecutive_failures',
        consecutiveFailures: 3,
      });
    });

    it('never auto-pauses when maxConsecutiveFailures is null [unit]', () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 50, maxConsecutiveFailures: null }),
        source: 'schedule',
        outcome: 'failed',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('scheduled');
    });

    it('leaves the streak alone on a cancelled run — neither a success nor a failure [unit]', () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 2 }),
        source: 'schedule',
        outcome: 'cancelled',
        iterationCount: 5,
        now: NOW,
      });
      expect((result.config as CronRepeatConfig).consecutiveFailures).to.equal(2);
      expect(result.status).to.equal('scheduled');
    });

    it("finishes as 'done' once the iteration budget is used up [unit]", () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ maxIterations: 5 }),
        source: 'schedule',
        outcome: 'done',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('done');
    });

    it("finishes as 'done' once the next fire would be past stopAfter [unit]", () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ stopAfter: '2026-09-26T12:00:00.000Z' }),
        source: 'schedule',
        outcome: 'done',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('done');
    });
  });

  describe('cron_repeat, manual "Run now"', () => {
    it('never touches the failure streak, so troubleshooting runs are free [unit]', () => {
      const failed = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 2 }),
        source: 'manual',
        outcome: 'failed',
        iterationCount: 5,
        now: NOW,
      });
      expect(failed.status).to.equal('scheduled');
      expect((failed.config as CronRepeatConfig).consecutiveFailures).to.equal(2);

      const succeeded = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ consecutiveFailures: 2 }),
        source: 'manual',
        outcome: 'done',
        iterationCount: 5,
        now: NOW,
      });
      expect((succeeded.config as CronRepeatConfig).consecutiveFailures).to.equal(2);
    });

    it("leaves a turned-off schedule at 'pending' rather than re-arming it [unit]", () => {
      const result = settleCronRun({
        type: 'cron_repeat',
        config: repeat({ enabled: false, pausedReason: 'consecutive_failures' }),
        source: 'manual',
        outcome: 'done',
        iterationCount: 5,
        now: NOW,
      });
      expect(result.status).to.equal('pending');
      expect(result.config).to.include({ enabled: false, pausedReason: 'consecutive_failures' });
    });
  });

  describe('cron_once', () => {
    it("ends with the run's outcome once its scheduled run finishes [unit]", () => {
      for (const outcome of ['done', 'failed', 'cancelled'] as const) {
        const result = settleCronRun({
          type: 'cron_once',
          config: once(),
          source: 'schedule',
          outcome,
          iterationCount: 1,
          now: NOW,
        });
        expect(result.status).to.equal(outcome);
      }
    });

    it('keeps waiting for its time after a manual run before it has fired [unit]', () => {
      const result = settleCronRun({
        type: 'cron_once',
        config: once({ fireAt: '2026-10-01T00:00:00.000Z', lastFiredAt: null }),
        source: 'manual',
        outcome: 'done',
        iterationCount: 0,
        now: NOW,
      });
      expect(result.status).to.equal('scheduled');
    });
  });
});
