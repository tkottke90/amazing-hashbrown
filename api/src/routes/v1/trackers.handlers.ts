import type { TrackerRegistry } from '../../services/tracker-registry.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface TrackerSummary {
  type: string;
  displayName: string;
  icon: string;
  canCreate: boolean;
  authSchema: unknown;
}

export function listTrackersHandler(registry: TrackerRegistry): HandlerResult<TrackerSummary[]> {
  return ok(
    registry.list().map((a) => ({
      type: a.type,
      displayName: a.displayName,
      icon: a.icon,
      canCreate: a.canCreate,
      authSchema: a.authSchema,
    })),
  );
}

export async function resolveTrackerUrlHandler(
  registry: TrackerRegistry,
  type: string,
  body: { url?: unknown },
): Promise<HandlerResult<unknown>> {
  const adapter = registry.get(type);
  if (!adapter) return notFound(`Tracker "${type}" is not registered`);
  if (!body.url || typeof body.url !== 'string') return badRequest('url is required');
  try {
    return ok(await adapter.resolveUrl(body.url));
  } catch (err) {
    return badRequest(errorMessage(err));
  }
}

export async function getTrackerItemHandler(
  registry: TrackerRegistry,
  type: string,
  id: string,
): Promise<HandlerResult<unknown>> {
  const adapter = registry.get(type);
  if (!adapter) return notFound(`Tracker "${type}" is not registered`);
  try {
    return ok(await adapter.getItem(id));
  } catch (err) {
    return notFound(errorMessage(err));
  }
}

export async function createTrackerItemHandler(
  registry: TrackerRegistry,
  type: string,
  body: { title?: unknown; body?: unknown; repo?: unknown },
): Promise<HandlerResult<unknown>> {
  const adapter = registry.get(type);
  if (!adapter) return notFound(`Tracker "${type}" is not registered`);
  if (!adapter.canCreate) return badRequest(`Tracker "${type}" cannot create items`);
  if (!body.title || typeof body.title !== 'string') return badRequest('title is required');
  try {
    return ok(
      await adapter.createItem({
        title: body.title,
        body: typeof body.body === 'string' ? body.body : undefined,
        repo: typeof body.repo === 'string' ? body.repo : undefined,
      }),
    );
  } catch (err) {
    return serverError(errorMessage(err));
  }
}

interface GithubVerifyResult {
  valid: boolean;
  scopes: string[];
  canCreate: boolean;
  error?: string;
}

export async function verifyGithubTokenHandler(body: {
  token?: unknown;
}): Promise<HandlerResult<GithubVerifyResult>> {
  if (!body.token || typeof body.token !== 'string') return badRequest('token is required');
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${body.token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return ok({ valid: false, scopes: [], canCreate: false, error: `GitHub API error ${res.status}` });
    }
    const scopesHeader = res.headers.get('x-oauth-scopes') ?? '';
    const scopes = scopesHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const canCreate = scopes.includes('repo') || scopes.includes('public_repo');
    return ok({ valid: true, scopes, canCreate });
  } catch (err) {
    return ok({ valid: false, scopes: [], canCreate: false, error: errorMessage(err) });
  }
}
