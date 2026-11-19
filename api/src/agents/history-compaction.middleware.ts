import { randomBytes } from 'node:crypto';
import { ToolMessage, isAIMessage, isHumanMessage, isToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import type { ContextWindowSchema, HistoryCompactionSchema } from '../config/env.js';
import { logger, serializeError } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { storeToolContent } from '../services/tool-content-store.js';
import { toolStub, STUB_THRESHOLD_CHARS } from './tools/tool-stub.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
// Import cycle with chat-agent.ts (which imports createHistoryCompactionMiddleware
// from this file) is safe: estimateTokens is a hoisted function declaration,
// only ever called from inside summarizeToolMessage's async body — never at
// either module's top level — so neither side depends on the other having
// finished evaluating first.
import { estimateTokens } from './chat-agent.js';

const HISTORY_COMPACTION_KIND = 'history-compaction';

// Same pattern as summary-boundary.ts's isSummaryBoundary — a recognizable,
// cheap tag so a later compaction pass never re-summarizes an already-short
// summary (or re-offloads its content under a second toolKey).
export function isHistoryCompacted(message: BaseMessage): boolean {
  const tag = message.additional_kwargs?.['hashbrown'] as { kind?: string } | undefined;
  return tag?.kind === HISTORY_COMPACTION_KIND;
}

// Private local copies — chat-agent.ts and summary-boundary.ts each already
// carry their own unexported version of this; a third copy here follows the
// same accepted precedent rather than introducing a shared util for it.
function findLastIndex(messages: BaseMessage[], pred: (m: BaseMessage) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && pred(m)) return i;
  }
  return -1;
}

function messageText(content: ToolMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

type ContextWindowConfig = z.infer<typeof ContextWindowSchema>;
type HistoryCompactionConfig = z.infer<typeof HistoryCompactionSchema>;

// Isolates the current turn (since the last HumanMessage), protects the most
// recent tool-call round (the last AIMessage with tool_calls and its paired
// ToolMessages) regardless of size, and of what remains, selects ToolMessages
// that are large enough to be worth a summarization call and aren't already
// compacted. Pure and independently unit-testable — no model involved.
export function selectCompactionCandidates(messages: BaseMessage[]): ToolMessage[] {
  const humanIdx = findLastIndex(messages, isHumanMessage);
  const turn = humanIdx === -1 ? messages : messages.slice(humanIdx);

  const lastToolCallAiIdx = findLastIndex(
    turn,
    (m) => isAIMessage(m) && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
  const protectedFromIdx = lastToolCallAiIdx === -1 ? turn.length : lastToolCallAiIdx;

  const candidates: ToolMessage[] = [];
  for (let i = 0; i < protectedFromIdx; i++) {
    const m = turn[i];
    if (!m || !isToolMessage(m)) continue;
    if (isHistoryCompacted(m)) continue;
    if (messageText(m.content).length <= STUB_THRESHOLD_CHARS) continue;
    candidates.push(m);
  }
  return candidates;
}

// Mirrors after-agent.ts's AfterAgentContextSchema / recursion-guard.middleware.ts's
// RecursionGuardContextSchema — the same context object already passed to
// agent.streamEvents() at every call site carries provider/model, so the
// summarizer can default to the live turn's own model rather than a
// hardcoded one. Overlapping optional fields across several middlewares'
// context schemas is an established, safe pattern in this file already.
const HistoryCompactionContextSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
});

// Keep this in sync with suites/history-compaction.yaml's scenario `input`
// fields — the eval suite tests this exact prompt template.
const SUMMARY_PROMPT_PREFIX =
  'Condense this tool call result so the agent can keep working without the full output in ' +
  'context. Capture: the specific facts, identifiers, file paths, and values a later step ' +
  'might still need. Drop formatting, repeated boilerplate, and anything already obvious from ' +
  'the tool name. Write it as plain prose, a few sentences at most. Do not include ' +
  'pleasantries or restate these instructions.\n\n';

interface SummarizeToolMessageOptions {
  threadId: string;
  llm: BaseChatModel;
  resolvedProvider: string;
  resolvedModel: string;
  maxSourceChars: number;
}

// Condenses a single ToolMessage's content into a short LLM-generated
// summary, offloading the original via the exact storeToolContent/toolStub
// mechanism truncateToolMessage (summary-boundary.ts) already uses, so the
// model can still retrieve the full original via get_tool_key if the
// summary turns out to be insufficient. Modeled on
// exhausted-run-summarizer.ts's whole-body try/catch shape (log a warning
// and return null, never throw) rather than workspace-summarizer.ts's
// heavier one — this must be a silent, isolated-per-message degrade, with
// no side effects beyond the one tool result it was asked to summarize.
//
// Exported (unlike truncateToolMessage, which stays private) specifically
// so tests can inject a replacement via createHistoryCompactionMiddleware's
// options.summarizeToolMessage — the real implementation makes a live model
// call, which is the one piece of this middleware that genuinely needs a
// test seam, the same way recursion-guard.middleware.ts's evaluateLoopProgress
// option exists purely for tests to inject a fake.
export async function summarizeToolMessage(
  original: ToolMessage,
  options: SummarizeToolMessageOptions,
): Promise<ToolMessage | null> {
  try {
    const originalContent = messageText(original.content);
    const toolName = original.name ?? 'unknown_tool';

    const truncated =
      originalContent.length > options.maxSourceChars
        ? originalContent.slice(-options.maxSourceChars)
        : originalContent;
    const prompt = `${SUMMARY_PROMPT_PREFIX}Tool: ${toolName}\n\nResult:\n${truncated}`;

    const turnObs = startTurnObservability({
      threadId: options.threadId,
      provider: options.resolvedProvider,
      model: options.resolvedModel,
      source: 'history-compaction',
      systemPrompt: prompt,
    });

    let content: string;
    let traceError: string | null = null;
    try {
      const response = await options.llm.invoke(prompt, { callbacks: [turnObs.obsHandler] });
      content =
        typeof response.content === 'string' ? response.content : String(response.content ?? '');
    } catch (err) {
      traceError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await turnObs.end(traceError);
    }

    const summary = content.trim();
    if (!summary) return null;

    const toolKey = `kv_${randomBytes(4).toString('hex')}`;
    storeToolContent(options.threadId, toolKey, originalContent);

    const newContent = toolStub(
      originalContent,
      { tool: toolName, key: toolKey, threadId: options.threadId },
      [
        { name: 'summary', content: summary },
        {
          name: 'note',
          content:
            'This tool result was condensed to fit the context budget. Use get_tool_key to ' +
            'read it in full if this summary turns out to be insufficient.',
        },
      ],
    );

    return new ToolMessage({
      content: newContent,
      tool_call_id: original.tool_call_id,
      name: original.name,
      id: original.id,
      additional_kwargs: {
        ...original.additional_kwargs,
        hashbrown: { kind: HISTORY_COMPACTION_KIND, toolKey },
      },
      response_metadata: original.response_metadata,
    });
  } catch (err) {
    logger.warn('historyCompaction: per-message summarization failed, leaving untouched', {
      tool: original.name,
      toolCallId: original.tool_call_id,
      err: serializeError(err as Error),
    });
    return null;
  }
}

interface ResolvedSummarizerModel {
  llm: BaseChatModel;
  resolvedProvider: string;
  resolvedModel: string;
}

// Separated out from createHistoryCompactionMiddleware's beforeModel body so
// it can be overridden independently of summarizeToolMessage in tests — a
// bare test environment has no providers configured at all
// (resolveProviderConfig throws "No providers configured"), so exercising
// the "candidates were replaced" path with an injected summarizeToolMessage
// stub must not still require a real, resolvable provider just to build the
// (unused, by the stub) `llm` argument.
function resolveSummarizerModel(
  historyCompactionCfg: HistoryCompactionConfig | undefined,
  contextProvider: string | undefined,
  contextModel: string | undefined,
): ResolvedSummarizerModel {
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    historyCompactionCfg?.summarizerProvider ?? contextProvider,
    historyCompactionCfg?.summarizerModel ?? contextModel,
  );
  return { llm: createProvider(resolvedProvider, resolvedModel), resolvedProvider, resolvedModel };
}

// Proactive, LLM-based condensation of older ToolMessage content once a
// turn is heading toward its context budget — a beforeModel-only
// middleware, no wrapModelCall stage, no new graph-state channel. Placed
// immediately before createContextWindowMiddleware in every builder's
// middleware array (chat-agent.ts): if this fully resolves the budget
// pressure, ContextWindowMiddleware's own trim stages are no-ops right
// after, same as always; if it does less than needed (nothing eligible, a
// summarizer call failed, summaries still too large), that existing
// trim/stub/ContextBudgetExceededError path is untouched and still catches
// it. See docs/superpowers/specs/2026-11-19-history-compaction-middleware-design.md.
export function createHistoryCompactionMiddleware(
  contextWindowCfg?: ContextWindowConfig,
  historyCompactionCfg?: HistoryCompactionConfig,
  options?: {
    summarizeToolMessage?: typeof summarizeToolMessage;
    resolveSummarizerModel?: typeof resolveSummarizerModel;
  },
) {
  return createMiddleware({
    name: 'HistoryCompactionMiddleware',
    contextSchema: HistoryCompactionContextSchema,
    beforeModel: async (state, runtime) => {
      if (historyCompactionCfg?.enabled === false) return undefined;

      const threadId = runtime?.configurable?.thread_id as string | undefined;
      if (!threadId) return undefined;

      const messages = state.messages as BaseMessage[];
      const maxTokens = contextWindowCfg?.maxTokens ?? 32000;
      const thresholdPct = historyCompactionCfg?.thresholdPct ?? 0.6;
      if (estimateTokens(messages) <= maxTokens * thresholdPct) return undefined;

      const candidates = selectCompactionCandidates(messages);
      if (candidates.length === 0) return undefined;

      const resolveModelImpl = options?.resolveSummarizerModel ?? resolveSummarizerModel;
      let resolvedProvider: string;
      let resolvedModel: string;
      let llm: BaseChatModel;
      try {
        ({ llm, resolvedProvider, resolvedModel } = resolveModelImpl(
          historyCompactionCfg,
          runtime?.context?.provider,
          runtime?.context?.model,
        ));
      } catch (err) {
        logger.warn('historyCompaction: summarizer model resolution failed, skipping this pass', {
          threadId,
          err: serializeError(err as Error),
        });
        return undefined;
      }

      const summarizeImpl = options?.summarizeToolMessage ?? summarizeToolMessage;
      const maxSourceChars = historyCompactionCfg?.maxSourceChars ?? 16000;

      let nextMessages = messages;
      let anyReplaced = false;
      for (const candidate of candidates) {
        const replacement = await summarizeImpl(candidate, {
          threadId,
          llm,
          resolvedProvider,
          resolvedModel,
          maxSourceChars,
        });
        if (!replacement) continue;
        nextMessages = nextMessages.map((m) => (m === candidate ? replacement : m));
        anyReplaced = true;
      }

      if (!anyReplaced) return undefined;

      logger.debug('historyCompaction: condensed older tool results', {
        threadId,
        candidateCount: candidates.length,
      });
      return { messages: nextMessages };
    },
  });
}
