import type { WorkspaceStore, TaskQueueEntry } from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import { enqueueTaskHandler } from './tasks.handlers.js';
import {
  cronExpressionError,
  describeSchedule,
  isValidTimeZone,
} from '../../services/cron-schedule.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

export function triggerWebhookHandler(
  store: WorkspaceStore,
  token: string,
): HandlerResult<TaskQueueEntry> {
  const task = store.findTaskByWebhookToken(token);
  if (!task) return notFound('No task matches this webhook URL');

  const result = enqueueTaskHandler(store, task.id, { triggerSource: 'webhook' });
  if (!result.ok) return result;
  return ok(result.data);
}

export interface CronPreview {
  valid: boolean;
  error?: string;
  description: string;
  nextFireTimes: string[];
}

// Validates a schedule as the user types it and reads it back: the
// cronstrue description plus the next fire times. The drawer takes no cron
// parser of its own — this is the one place its preview comes from, so the
// preview and the scheduler can never disagree. An invalid schedule is a
// 200 with valid: false (the drawer shows the message inline); only a
// malformed request is a 400.
export function previewCronHandler(
  body: unknown,
  now: Date = new Date(),
): HandlerResult<CronPreview> {
  if (typeof body !== 'object' || body === null) return badRequest('Request body is required');
  const { expression, fireAt, timezone } = body as Record<string, unknown>;
  if (typeof timezone !== 'string') return badRequest('timezone is required');
  const invalid = (error: string) =>
    ok<CronPreview>({ valid: false, error, description: '', nextFireTimes: [] });

  if (typeof expression === 'string') {
    const error = cronExpressionError(expression, timezone);
    if (error) return invalid(error);
    const { description, nextFireTimes } = describeSchedule(
      {
        kind: 'cron_repeat',
        expression,
        timezone,
        enabledAt: now.toISOString(),
        lastFiredAt: null,
        maxIterations: null,
        stopAfter: null,
      },
      now,
    );
    return ok({
      valid: true,
      description,
      nextFireTimes: nextFireTimes.map((d) => d.toISOString()),
    });
  }

  if (typeof fireAt === 'string') {
    if (!isValidTimeZone(timezone)) return invalid(`Unknown time zone "${timezone}".`);
    const at = new Date(fireAt);
    if (Number.isNaN(at.getTime())) return invalid('fireAt must be a valid date');
    if (at.getTime() <= now.getTime()) return invalid('fireAt must be in the future');
    return ok({ valid: true, description: 'Once', nextFireTimes: [at.toISOString()] });
  }

  return badRequest('expression or fireAt is required');
}
