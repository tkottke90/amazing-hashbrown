import type { ToolFrictionStore } from '@tkottke90/observability';
import type { ShellAuditStore } from '../../services/shell-audit.js';

// Plain, Express-agnostic handler functions — no req/res anywhere, same
// idiom as skills.handlers.ts/settings.handlers.ts.

export interface HandlerFailure {
  ok: false;
  status: 400 | 500;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function defaultDateRange(): { defaultFrom: string; todayStr: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return { defaultFrom: thirtyDaysAgo.toISOString().slice(0, 10), todayStr };
}

export function getToolFrictionHandler(
  store: ToolFrictionStore,
  query: { from?: string; to?: string; toolName?: string },
): HandlerResult<{
  from: string;
  to: string;
  rows: { toolName: string; date: string; callCount: number; errorCount: number }[];
}> {
  const { defaultFrom, todayStr } = defaultDateRange();
  const from = query.from ?? defaultFrom;
  const to = query.to ?? todayStr;

  const rows = store.queryFriction({
    from,
    to,
    ...(query.toolName ? { toolName: query.toolName } : {}),
  });

  return ok({ from, to, rows });
}

export function getFileToolAdoptionHandler(
  store: ShellAuditStore,
  query: { from?: string; to?: string },
): HandlerResult<{
  from: string;
  to: string;
  rows: { date: string; source: string; readCount: number; writeCount: number }[];
}> {
  const { defaultFrom, todayStr } = defaultDateRange();
  const from = query.from ?? defaultFrom;
  const to = query.to ?? todayStr;

  const rows = store.queryFileToolAdoption({ from, to });

  return ok({ from, to, rows });
}
