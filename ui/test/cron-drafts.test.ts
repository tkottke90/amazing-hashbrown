import {
  inactiveScheduleMessage,
  onceConfigFrom,
  onceDraftFrom,
  repeatConfigFrom,
  repeatDraftFrom,
} from '@/lib/cron-drafts';

describe('cron-drafts', () => {
  it('fills a new repeat schedule with the default failure limit and the browser zone', () => {
    const draft = repeatDraftFrom(null);
    expect(draft).toMatchObject({
      expression: '',
      enabled: true,
      maxIterations: '',
      stopAfter: '',
      maxConsecutiveFailures: '3',
    });
    expect(draft.timezone).toBeTruthy();
  });

  it('shows a stored "never auto-pause" (null) as a blank field, not the default', () => {
    const draft = repeatDraftFrom({
      expression: '0 0 * * *',
      timezone: 'UTC',
      enabled: true,
      maxIterations: 10,
      stopAfter: null,
      maxConsecutiveFailures: null,
    });
    expect(draft.maxConsecutiveFailures).toBe('');
    expect(draft.maxIterations).toBe('10');
  });

  it('round-trips a repeat schedule, sending blanks as null and numbers as numbers', () => {
    const config = repeatConfigFrom({
      expression: ' 0 9 * * 1-5 ',
      timezone: 'America/Chicago',
      enabled: false,
      maxIterations: '',
      stopAfter: '',
      maxConsecutiveFailures: '5',
    });
    expect(config).toEqual({
      expression: '0 9 * * 1-5',
      timezone: 'America/Chicago',
      enabled: false,
      maxIterations: null,
      stopAfter: null,
      maxConsecutiveFailures: 5,
    });
  });

  it('makes "stop after" inclusive of that whole day', () => {
    const config = repeatConfigFrom({ ...repeatDraftFrom(null), stopAfter: '2026-09-30' });
    const stop = new Date(config.stopAfter!);
    expect(stop.getDate()).toBe(30);
    expect(stop.getHours()).toBe(23);
    expect(stop.getMinutes()).toBe(59);
  });

  it('round-trips a one-shot time through the datetime-local input format', () => {
    const draft = onceDraftFrom({
      fireAt: '2026-10-01T15:30:00.000Z',
      timezone: 'UTC',
      enabled: true,
    });
    expect(onceConfigFrom(draft).fireAt).toBe('2026-10-01T15:30:00.000Z');
  });

  it('words each inactive reason for the drawer banner', () => {
    const schedule = { iterationCount: 10 };
    expect(inactiveScheduleMessage('failures', schedule, { consecutiveFailures: 3 })).toBe(
      'Paused after 3 consecutive failures',
    );
    expect(inactiveScheduleMessage('exhausted', schedule, { maxIterations: 10 })).toBe(
      'Finished — 10 of 10 runs',
    );
    expect(
      inactiveScheduleMessage('expired', schedule, { stopAfter: '2026-09-30T12:00:00.000Z' }),
    ).toMatch(/^Stopped — past Sep 30/);
    expect(
      inactiveScheduleMessage('fired', schedule, { lastFiredAt: '2026-09-26T00:00:00.000Z' }),
    ).toMatch(/^Fired on /);
    expect(inactiveScheduleMessage('disabled', schedule, {})).toBe('Schedule is off');
  });
});
