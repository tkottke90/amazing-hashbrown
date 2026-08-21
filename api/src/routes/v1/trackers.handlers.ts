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

type GithubTokenType = 'classic' | 'fine-grained' | 'unknown';

interface GithubVerifyResult {
  valid: boolean;
  scopes: string[];
  canCreate: boolean;
  tokenType: GithubTokenType;
  error?: string;
}

// Fine-grained PATs (the type GitHub now recommends) don't carry OAuth-style
// scopes at all — GitHub grants them per-repository permissions instead —
// so `GET /user` never returns an X-OAuth-Scopes header for one. Detecting
// the token shape from its prefix lets us stop reporting a fine-grained
// token as "needs repo scope", which is both wrong and nonsensical advice
// for a token type that has no such scope to add. There's no equivalent
// upfront capability check for fine-grained tokens (permission is scoped
// per-repository, and this endpoint has no repo in context), so `canCreate`
// is optimistic here — same as the adapter's own boot-time check
// (`Boolean(token)`), which already lets GitHub's real API call be the
// actual source of truth rather than trying to predict it.
function classifyGithubToken(token: string): GithubTokenType {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  return 'unknown';
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
      return ok({
        valid: false,
        scopes: [],
        canCreate: false,
        tokenType: 'unknown',
        error: `GitHub API error ${res.status}`,
      });
    }
    const scopesHeader = res.headers.get('x-oauth-scopes') ?? '';
    const scopes = scopesHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let tokenType: GithubTokenType;
    let canCreate: boolean;
    if (scopes.length > 0) {
      tokenType = 'classic';
      canCreate = scopes.includes('repo') || scopes.includes('public_repo');
    } else if (classifyGithubToken(body.token) === 'fine-grained') {
      tokenType = 'fine-grained';
      canCreate = true;
    } else {
      tokenType = 'unknown';
      canCreate = false;
    }

    return ok({ valid: true, scopes, canCreate, tokenType });
  } catch (err) {
    return ok({
      valid: false,
      scopes: [],
      canCreate: false,
      tokenType: 'unknown',
      error: errorMessage(err),
    });
  }
}
