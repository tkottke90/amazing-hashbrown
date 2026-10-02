import type { ApiKeyStore } from '../../services/api-key-store.js';
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

export function createApiKeyHandler(
  store: ApiKeyStore,
  body: Record<string, unknown>,
): HandlerResult<ReturnType<ApiKeyStore['create']>> {
  const name = body['name'];
  if (typeof name !== 'string' || !name.trim()) return badRequest('name is required');
  return ok(store.create(name.trim()));
}

// Never fails — returns the plain list directly rather than a HandlerResult.
export function listApiKeysHandler(store: ApiKeyStore): ReturnType<ApiKeyStore['list']> {
  return store.list();
}

export function rotateApiKeyHandler(
  store: ApiKeyStore,
  id: string,
): HandlerResult<{ id: string; name: string; key: string; updatedAt: string }> {
  const rotated = store.rotate(id);
  if (!rotated) return notFound(`API key ${id} not found`);
  // Strip createdAt — the documented rotate response is { id, name, key, updatedAt }.
  return ok({ id: rotated.id, name: rotated.name, key: rotated.key, updatedAt: rotated.updatedAt });
}

export function revokeApiKeyHandler(
  store: ApiKeyStore,
  id: string,
): HandlerResult<{ deleted: true }> {
  const deleted = store.revoke(id);
  if (!deleted) return notFound(`API key ${id} not found`);
  return ok({ deleted: true });
}
