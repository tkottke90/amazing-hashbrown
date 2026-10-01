import { describe, it } from 'mocha';
import { expect } from 'chai';
import { env } from '../config/env.js';
import {
  describeTaskSchedule,
  resolveCronConfig,
  statusForSavedSchedule,
  type CronOnceConfig,
  type CronRepeatConfig,
} from './cron-config.js';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const LATER = new Date('2026-09-28T12:00:00.000Z');

function repeatConfig(overrides: Partial<CronRepeatConfig> = {}): CronRepeatConfig {
  return {
    expression: '0 0 * * *',
    timezone: 'UTC',
    enabled: true,
    maxIterations: null,
    stopAfter: null,
    maxConsecutiveFailures: 3,
    enabledAt: '2026-09-01T00:00:00.000Z',
    lastFiredAt: '2026-09-26T00:00:00.000Z',
    consecutiveFailures: 2,
    pausedReason: null,
    ...overrides,
  };
}

describe('services/cron-config', () => {
  describe('resolveCronConfig() — cron_repeat', () => {
    it('validates and fills defaults for a new schedule, stamping when it was enabled [unit]', () => {
      const result = resolveCronConfig(
        'cron_repeat',
        null,
        { expression: ' 0 9 * * 1-5 ', timezone: 'America/Chicago' },
        NOW,
      );
      expect(result).to.deep.equal({
        ok: true,
        config: {
          expression: '0 9 * * 1-5',
          timezone: 'America/Chicago',
          enabled: true,
          maxIterations: null,
          stopAfter: null,
          maxConsecutiveFailures: 3,
          enabledAt: NOW.toISOString(),
          lastFiredAt: null,
          consecutiveFailures: 0,
          pausedReason: null,
        },
      });
    });

    it('keeps an explicit null maxConsecutiveFailures, meaning never auto-pause [unit]', () => {
      const result = resolveCronConfig(
        'cron_repeat',
        null,
        { expression: '0 0 * * *', timezone: 'UTC', maxConsecutiveFailures: null },
        NOW,
      );
      expect(result.ok && (result.config as CronRepeatConfig).maxConsecutiveFailures).to.equal(
        null,
      );
    });

    it('reports a bad expression or time zone as a field error [unit]', () => {
      const badExpr = resolveCronConfig(
        'cron_repeat',
        null,
        { expression: '* *', timezone: 'UTC' },
        NOW,
      );
      expect(badExpr).to.deep.include({ ok: false });
      expect(!badExpr.ok && badExpr.error).to.match(/^expression Use the 5-field form/);

      const badTz = resolveCronConfig(
        'cron_repeat',
        null,
        { expression: '0 0 * * *', timezone: 'Mars/Olympus' },
        NOW,
      );
      expect(!badTz.ok && badTz.error).to.match(/^timezone must be a valid IANA time zone/);
    });

    it('never lets a client overwrite the fields the scheduler owns [unit]', () => {
      const current = repeatConfig();
      const result = resolveCronConfig(
        'cron_repeat',
        current,
        {
          expression: '0 1 * * *',
          timezone: 'UTC',
          lastFiredAt: '2020-01-01T00:00:00.000Z',
          consecutiveFailures: 0,
          enabledAt: '2020-01-01T00:00:00.000Z',
        },
        LATER,
      );
      expect(result.ok).to.equal(true);
      const config = (result as { config: CronRepeatConfig }).config;
      expect(config.expression).to.equal('0 1 * * *');
      expect(config.lastFiredAt).to.equal(current.lastFiredAt);
      expect(config.consecutiveFailures).to.equal(2);
      expect(config.enabledAt).to.equal(current.enabledAt);
    });

    it('re-enabling a paused schedule clears the failures and restarts the catch-up window [unit]', () => {
      const current = repeatConfig({
        enabled: false,
        consecutiveFailures: 3,
        pausedReason: 'consecutive_failures',
      });
      const result = resolveCronConfig(
        'cron_repeat',
        current,
        { expression: '0 0 * * *', timezone: 'UTC', enabled: true },
        LATER,
      );
      const config = (result as { config: CronRepeatConfig }).config;
      expect(config).to.include({
        enabled: true,
        consecutiveFailures: 0,
        pausedReason: null,
        enabledAt: LATER.toISOString(),
      });
    });
  });

  describe('timezone default (a caller with nothing to prefill from, e.g. the chat tool)', () => {
    it('defaults an omitted timezone to the server-configured default for cron_repeat [unit]', () => {
      const result = resolveCronConfig('cron_repeat', null, { expression: '0 0 * * *' }, NOW);
      expect(result.ok && (result.config as CronRepeatConfig).timezone).to.equal(env.timezone);
    });

    it('defaults an omitted timezone to the server-configured default for cron_once [unit]', () => {
      const result = resolveCronConfig('cron_once', null, { fireAt: LATER.toISOString() }, NOW);
      expect(result.ok && (result.config as CronOnceConfig).timezone).to.equal(env.timezone);
    });

    it('keeps an explicitly provided timezone rather than the default [unit]', () => {
      const result = resolveCronConfig(
        'cron_repeat',
        null,
        { expression: '0 0 * * *', timezone: 'America/Chicago' },
        NOW,
      );
      expect(result.ok && (result.config as CronRepeatConfig).timezone).to.equal('America/Chicago');
    });
  });

  describe('resolveCronConfig() — cron_once', () => {
    it('requires a valid date [unit]', () => {
      const result = resolveCronConfig('cron_once', null, { fireAt: 'soon', timezone: 'UTC' }, NOW);
      expect(!result.ok && result.error).to.equal('fireAt must be a valid date');
    });

    it('rejects a new or moved time in the past, which would never fire [unit]', () => {
      const result = resolveCronConfig(
        'cron_once',
        null,
        { fireAt: '2026-09-26T11:59:00.000Z', timezone: 'UTC' },
        NOW,
      );
      expect(!result.ok && result.error).to.equal('fireAt must be in the future');
    });

    it('re-arms a one-shot that already fired when it is moved to a new time [unit]', () => {
      const current: CronOnceConfig = {
        fireAt: '2026-09-20T09:00:00.000Z',
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-09-01T00:00:00.000Z',
        lastFiredAt: '2026-09-20T09:00:00.000Z',
      };
      const moved = resolveCronConfig(
        'cron_once',
        current,
        { fireAt: '2026-10-01T09:00:00.000Z', timezone: 'UTC' },
        NOW,
      );
      expect((moved as { config: CronOnceConfig }).config.lastFiredAt).to.equal(null);

      const unchanged = resolveCronConfig(
        'cron_once',
        current,
        { fireAt: '2026-09-20T09:00:00Z', timezone: 'UTC' },
        NOW,
      );
      expect((unchanged as { config: CronOnceConfig }).config.lastFiredAt).to.equal(
        current.lastFiredAt,
      );
    });
  });

  describe('statusForSavedSchedule()', () => {
    it("puts an idle task with a live schedule into 'scheduled' [unit]", () => {
      expect(statusForSavedSchedule('pending', 'cron_repeat', repeatConfig(), 0, NOW)).to.equal(
        'scheduled',
      );
    });

    it("takes a turned-off schedule out of 'scheduled' [unit]", () => {
      expect(
        statusForSavedSchedule(
          'scheduled',
          'cron_repeat',
          repeatConfig({ enabled: false }),
          0,
          NOW,
        ),
      ).to.equal('pending');
    });

    it('never moves a task that is queued, running, waiting on the user or paused [unit]', () => {
      for (const busy of ['ready', 'running', 'waiting_on_user', 'blocked'] as const) {
        expect(statusForSavedSchedule(busy, 'cron_repeat', repeatConfig(), 0, NOW)).to.equal(null);
      }
    });

    it('brings a finished recurring task back when its budget is raised [unit]', () => {
      const config = repeatConfig({ maxIterations: 10 });
      expect(statusForSavedSchedule('done', 'cron_repeat', config, 5, NOW)).to.equal('scheduled');
      expect(statusForSavedSchedule('done', 'cron_repeat', config, 10, NOW)).to.equal(null);
    });

    it('keeps an unfired one-shot scheduled even once its time has passed, so it catches up [unit]', () => {
      const config: CronOnceConfig = {
        fireAt: '2026-09-25T09:00:00.000Z',
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-09-01T00:00:00.000Z',
        lastFiredAt: null,
      };
      expect(statusForSavedSchedule('pending', 'cron_once', config, 0, NOW)).to.equal('scheduled');
    });

    it('does not park a one-shot whose time passed before it was turned on — it can never fire [unit]', () => {
      const config: CronOnceConfig = {
        fireAt: '2026-09-25T09:00:00.000Z',
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-09-26T00:00:00.000Z',
        lastFiredAt: null,
      };
      expect(statusForSavedSchedule('pending', 'cron_once', config, 0, NOW)).to.equal(null);
    });
  });

  describe('describeTaskSchedule()', () => {
    it('reports the next fire time of a live schedule [unit]', () => {
      expect(describeTaskSchedule('cron_repeat', repeatConfig(), 4, NOW)).to.deep.equal({
        nextFireAt: '2026-09-27T00:00:00.000Z',
        iterationCount: 4,
        active: true,
        inactiveReason: null,
      });
    });

    it('tells an auto-pause apart from a schedule the user turned off [unit]', () => {
      const paused = repeatConfig({ enabled: false, pausedReason: 'consecutive_failures' });
      expect(describeTaskSchedule('cron_repeat', paused, 4, NOW).inactiveReason).to.equal(
        'failures',
      );
      const off = repeatConfig({ enabled: false });
      expect(describeTaskSchedule('cron_repeat', off, 4, NOW).inactiveReason).to.equal('disabled');
    });

    it('tells a used-up run budget apart from a passed stop date [unit]', () => {
      const budget = repeatConfig({ maxIterations: 4 });
      expect(describeTaskSchedule('cron_repeat', budget, 4, NOW)).to.include({
        active: false,
        inactiveReason: 'exhausted',
        nextFireAt: null,
      });
      const stopped = repeatConfig({ stopAfter: '2026-09-26T06:00:00.000Z' });
      expect(describeTaskSchedule('cron_repeat', stopped, 4, NOW).inactiveReason).to.equal(
        'expired',
      );
    });

    it("marks a one-shot that already fired as 'fired' [unit]", () => {
      const config: CronOnceConfig = {
        fireAt: '2026-09-26T09:00:00.000Z',
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-09-01T00:00:00.000Z',
        lastFiredAt: '2026-09-26T09:00:00.000Z',
      };
      expect(describeTaskSchedule('cron_once', config, 1, NOW).inactiveReason).to.equal('fired');
    });
  });
});
