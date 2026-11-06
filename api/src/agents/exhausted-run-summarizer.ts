import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger, serializeError } from '../config/logger.js';
import type { ThreadStore } from '../services/thread-store.js';
import type { TaskRun } from '../services/workspace-store.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
import { transcriptLine } from './thread-text.js';

// Keep this in sync with suites/exhausted-run-retry.yaml's scenario `input`
// field — the eval suite tests this exact prompt template.
const SUMMARY_PROMPT_PREFIX =
  'The previous attempt at this task hit a hard resource limit before finishing. Condense ' +
  'what it already tried, found, and ruled out into a short briefing for whoever retries it ' +
  "next, so the retry doesn't repeat the same dead ends. Capture: what was attempted, what " +
  'worked or failed; what specifically contributed to hitting the resource limit (e.g. one ' +
  'oversized tool result, or too many repeated steps) and what the retry should avoid doing ' +
  'again as a result; and anything else to try differently. Write a few sentences of plain ' +
  'prose. Do not include pleasantries or restate these instructions.\n\nTranscript:\n';

const MAX_RUN_MESSAGES = 10_000; // same cap as formatRunTranscript
const MAX_TRANSCRIPT_CHARS = 16_000; // same cap as workspace-summarizer

// Condenses a Narrowed Retry's prior Exhausted Run into a short "what was
// already tried" briefing for buildRunKickoff() (task-context.ts) — a
// single plain, non-agentic model.invoke() over the run's transcript, no
// tool harness, modeled on maybeSummarizeWorkspace (workspace-summarizer.ts).
//
// Must never throw: a missing condensed summary just means the Narrowed
// Retry proceeds with a plainer kickoff, not a failed run. See ADR-0056,
// GLOSSARY.md § Narrowed Retry.
export async function summarizeExhaustedRun(
  threadStore: ThreadStore,
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  priorRun: TaskRun,
): Promise<string | null> {
  try {
    if (!priorRun.threadId) return null;
    const lines = threadStore
      .getThreadMessages(priorRun.threadId, { limit: MAX_RUN_MESSAGES })
      .filter((m) => !m.superseded)
      .map(transcriptLine)
      .filter((line): line is string => line !== null);
    if (lines.length === 0) return null;
    const transcript = lines.join('\n');
    const truncated =
      transcript.length > MAX_TRANSCRIPT_CHARS
        ? transcript.slice(-MAX_TRANSCRIPT_CHARS)
        : transcript;
    const prompt = `${SUMMARY_PROMPT_PREFIX}${truncated}`;

    const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
      provider,
      modelName,
    );
    const turnObs = startTurnObservability({
      threadId: priorRun.threadId ?? undefined,
      provider: resolvedProvider,
      model: resolvedModel,
      source: 'exhausted-run-retry',
      systemPrompt: prompt,
    });

    let content: string;
    let traceError: string | null = null;
    try {
      const response = await model.invoke(prompt, { callbacks: [turnObs.obsHandler] });
      content =
        typeof response.content === 'string' ? response.content : String(response.content ?? '');
    } catch (err) {
      traceError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await turnObs.end(traceError);
    }

    const trimmed = content.trim();
    return trimmed || null;
  } catch (err) {
    logger.warn('exhausted-run-summarizer: summarization failed, retrying without it', {
      runId: priorRun.id,
      err: serializeError(err),
    });
    return null;
  }
}
