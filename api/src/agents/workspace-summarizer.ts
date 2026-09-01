import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { SseWriter } from './active-sse-writer.js';
import { env } from '../config/env.js';
import { logger, serializeError } from '../config/logger.js';
import { getObservabilityStore } from '../services/observability.js';
import type { ThreadStore } from '../services/thread-store.js';
import type { Workspace, WorkspaceStore } from '../services/workspace-store.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import { invalidateWorkspaceChatAgent } from './chat-agent.js';
import { writeSseEvent } from './stream-handler.js';

// Keep this in sync with suites/workspace-summary.yaml's scenario `input`
// fields — the eval suite tests this exact prompt template.
const SUMMARY_PROMPT_PREFIX =
  'Summarize this workspace conversation for continuity into a future session. Capture: key ' +
  'decisions made, open threads or questions still unresolved, and specific files or paths ' +
  'touched. Write it as a structured markdown document with headings. Do not include ' +
  'pleasantries or restate these instructions.\n\nConversation:\n';

const MAX_SUMMARY_SOURCE_MESSAGES = 200;
const MAX_SUMMARY_TRANSCRIPT_CHARS = 16000;

// Summarizes a workspace's chat thread since its last summary cursor, when
// the message-count threshold is crossed (or unconditionally when
// force:true, for the on-demand "Summarise" button). Modeled on
// generateTitleHandler (threads.handlers.ts) — a single plain,
// non-agentic model.invoke() over the thread's content, no tool harness.
//
// `sink` is the live SSE writer for an in-turn (automatic) call, so
// summarizing_start/summarizing_end can ride the same connection as the
// chat stream; it's undefined for the on-demand endpoint, which has no SSE
// connection of its own — those events are simply skipped in that case.
//
// This function must never throw: it's called after finalizeTurn() has
// already completed and sent stream_done for the turn, so an uncaught
// error here would otherwise propagate into the caller's own error
// handling and incorrectly mark an already-finished turn as failed.
export async function maybeSummarizeWorkspace(
  sink: SseWriter | undefined,
  store: WorkspaceStore,
  threadStore: ThreadStore,
  workspace: Workspace,
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const enabled = env.chat.workspaceSummary?.enabled ?? true;
  if (!enabled || !workspace.threadId) return;

  const sinceLast = threadStore.getThreadMessages(workspace.threadId, {
    afterMessageId: workspace.lastSummarizedMessageId ?? undefined,
    limit: MAX_SUMMARY_SOURCE_MESSAGES,
  });
  const conversational = sinceLast.filter((m) => m.kind === 'user' || m.kind === 'assistant');
  if (conversational.length === 0) return;

  const threshold = env.chat.workspaceSummary?.messageThreshold ?? 40;
  if (!force && conversational.length < threshold) return;

  if (sink) writeSseEvent(sink, { type: 'summarizing_start' });

  try {
    const transcript = conversational
      .map((m) => {
        const payload = (m.payload ?? {}) as { content?: unknown };
        const speaker = m.kind === 'user' ? 'User' : 'Assistant';
        return `${speaker}: ${typeof payload.content === 'string' ? payload.content : ''}`;
      })
      .join('\n');
    const truncated =
      transcript.length > MAX_SUMMARY_TRANSCRIPT_CHARS
        ? transcript.slice(-MAX_SUMMARY_TRANSCRIPT_CHARS)
        : transcript;
    const prompt = `${SUMMARY_PROMPT_PREFIX}${truncated}`;

    const obsStore = getObservabilityStore();
    const traceId = obsStore.startTrace({
      threadId: workspace.threadId,
      provider: provider ?? env.defaultProvider,
      model: modelName ?? '',
      source: 'workspace-summary',
      systemPrompt: prompt,
    });
    const obsHandler = new ObservabilityCallbackHandler(
      traceId,
      obsStore,
      env.observability.spanOutputPreviewChars,
    );

    let content: string;
    try {
      const response = await model.invoke(prompt, { callbacks: [obsHandler] });
      content =
        typeof response.content === 'string' ? response.content : String(response.content ?? '');
    } finally {
      // A bare model.invoke() (no chain/graph wrapping it) never fires
      // handleChainEnd on its own — see generateTitleHandler's identical
      // note — so this must run whether the call above succeeded or threw.
      await obsHandler.handleChainEnd();
      obsStore.endTrace(traceId, {
        totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
      });
    }

    const timestamp = new Date().toISOString();
    const summaryRelPath = path.join(
      '.hashbrown',
      'summaries',
      `${timestamp.replace(/[:.]/g, '-')}.md`,
    );
    await mkdir(path.join(workspace.location, '.hashbrown', 'summaries'), { recursive: true });
    await writeFile(path.join(workspace.location, summaryRelPath), content, 'utf8');

    // The summary message becomes the new cursor itself (not the last
    // original message it summarized) — so the "hide messages at/before the
    // cursor" read-side filter (afterMessageId) also hides this marker row,
    // and only the context notice (built from workspace.summaryPath)
    // represents it in the UI, rather than rendering as a chat bubble.
    const summaryMessageId = randomUUID();
    threadStore.insertMessage(workspace.threadId, {
      id: summaryMessageId,
      kind: 'summary',
      payload: { content, summaryPath: summaryRelPath },
    });

    store.patchWorkspace(workspace.id, {
      summaryPath: summaryRelPath,
      lastSummarizedMessageId: summaryMessageId,
    });
    // The system prompt's context block now includes this summary — drop
    // the cached agent so the next turn picks it up.
    invalidateWorkspaceChatAgent(workspace.id);

    if (sink) writeSseEvent(sink, { type: 'summarizing_end' });
  } catch (err) {
    logger.error('workspace-summarizer: summarization failed', {
      workspaceId: workspace.id,
      err: serializeError(err),
    });
    if (sink) {
      writeSseEvent(sink, {
        type: 'summarizing_end',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
