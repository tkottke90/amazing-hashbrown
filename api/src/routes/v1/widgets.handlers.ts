import { z } from 'zod';
import { parseWidgetFile } from '@tkottke90/amazing-hashbrown-widgets';
import { logger } from '../../config/logger.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

const ValidateWidgetBodySchema = z.object({
  dashboardId: z.string().min(1),
  widgetId: z.string().min(1),
  raw: z.string(),
});

export interface ValidatedWidgetFields {
  title: string;
  subtitle?: string;
  type: 'markdown';
  order: number;
  content: string;
}

export type ValidateWidgetResult =
  | { ok: true; widget: ValidatedWidgetFields }
  | { ok: false; error: string };

/**
 * Dry-run validation of a widget file's raw text — not nested under a
 * widget's own resource path (no `:dashboardId`/`:id`) because this checks
 * submitted text, not a stored resource: `dashboardId`/`widgetId` are
 * logged for correlation only and never used to look anything up, and no
 * file is read or written here. Reuses `parseWidgetFile`, the same parse
 * path `listWidgets` uses, so this endpoint and a real save can never
 * disagree about what counts as valid. An invalid *file* is a normal,
 * successful validation response (`{ok:true, data:{ok:false,error}}`); only
 * a malformed *request* is a 400.
 */
export function validateWidgetHandler(body: unknown): HandlerResult<ValidateWidgetResult> {
  const parsed = ValidateWidgetBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const { dashboardId, widgetId, raw } = parsed.data;
  const result = parseWidgetFile(raw);
  logger.info('Widget raw content validated', { dashboardId, widgetId, ok: result.ok });
  if (!result.ok) {
    return ok<ValidateWidgetResult>({ ok: false, error: result.error });
  }
  return ok<ValidateWidgetResult>({ ok: true, widget: result.widget });
}
