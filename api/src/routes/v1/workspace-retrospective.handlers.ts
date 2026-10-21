import {
  buildWorkspaceRetrospective,
  renderWorkspaceRetrospectiveHtml,
} from '@tkottke90/workspace-reports';
import type { WorkspaceStore } from '../../services/workspace-store.js';
import type { ThreadStore } from '../../services/thread-store.js';
import { getObservabilityStore } from '../../services/observability.js';
import { createProvider } from '../../services/provider-factory.js';
import { generateRetrospectiveNarrative } from '../../agents/workspace-retrospective-narrative.js';
import { logger, serializeError } from '../../config/logger.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

export interface WorkspaceRetrospectiveParams {
  provider?: string;
  model?: string;
  // Skips the one-shot LLM narrative pass — the deterministic sections
  // (summary, anomalies, task ledger) are unaffected either way. Defaults to
  // true; set false for a fast, model-independent report.
  narrative?: boolean;
}

export async function generateWorkspaceRetrospectiveHandler(
  stores: { workspaceStore: WorkspaceStore; threadStore: ThreadStore },
  workspaceId: string,
  params: WorkspaceRetrospectiveParams = {},
): Promise<HandlerResult<{ html: string }>> {
  const data = buildWorkspaceRetrospective(workspaceId, {
    workspaceStore: stores.workspaceStore,
    threadStore: stores.threadStore,
    observabilityStore: getObservabilityStore(),
  });
  if (!data) return notFound(`Workspace "${workspaceId}" not found`);

  const wantsNarrative = params.narrative !== false;
  if (wantsNarrative) {
    // Best-effort — a misconfigured/unavailable model must never fail the
    // report itself, since every other section is already fully computed
    // from deterministic data. createProvider() (unlike the narrative
    // generator's own internal model.invoke()) can throw synchronously on a
    // bad/missing provider config, so it's covered by this same try/catch.
    try {
      const threadMeta = data.chat ? stores.threadStore.getThreadMeta(data.chat.threadId) : null;
      const effectiveProvider = params.provider ?? threadMeta?.provider ?? undefined;
      const effectiveModel = params.model ?? threadMeta?.model ?? undefined;
      data.narrative = await generateRetrospectiveNarrative({
        data,
        model: createProvider(effectiveProvider, effectiveModel),
        provider: effectiveProvider,
        modelName: effectiveModel,
      });
    } catch (err) {
      logger.warn('workspace-retrospective: narrative pass skipped (model unavailable)', {
        workspaceId,
        err: serializeError(err),
      });
    }
  }

  const html = await renderWorkspaceRetrospectiveHtml(data);
  return ok({ html });
}
