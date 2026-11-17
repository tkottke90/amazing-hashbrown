import type { ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';
import type { ProviderQueue } from '../../services/provider-queue.js';
import type { HandlerResult } from './threads.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

// The REST fallback behind GET /api/v1/provider-activity — used by a client
// reconnecting its SSE connection (or loading the Provider Activity Monitor
// for the first time) to reconstruct the same live state the
// `provider_activity_update` broadcast otherwise pushes on every
// acquire/release/abort. Pure in-memory read, no failure mode of its own.
export function getProviderActivityHandler(
  providerQueue: ProviderQueue,
  providerNames: string[],
): HandlerResult<ProviderActivitySnapshot[]> {
  return ok(providerQueue.getAllGateSnapshots(providerNames));
}
