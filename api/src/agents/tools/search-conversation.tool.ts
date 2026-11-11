import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { env } from '../../config/env.js';
import { getThreadStore, type ThreadMessageRecord } from '../../services/thread-store.js';
import { extractText } from '../thread-text.js';
import { rankMessages } from './thread-search-ranking.js';

const SearchConversationSchema = z.object({
  query: z.string().describe('Natural language query to search the conversation history.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe('Number of turns to return (default 5).'),
});

export const searchConversationTool = tool(
  async ({ query, limit }, config: RunnableConfig | undefined) => {
    const threadId = config?.configurable?.['thread_id'] as string | undefined;
    if (!threadId) return 'Conversation search unavailable: no thread context.';

    const chatCfg = env.chat;
    if (chatCfg.conversationSearch?.enabled === false) {
      return 'Conversation search is disabled in config.';
    }
    const threshold = chatCfg.conversationSearch?.threshold ?? 20;

    const threadStore = getThreadStore();
    // Superseded failed attempts are excluded from the search corpus — a
    // retried-over error isn't real conversation content worth citing back.
    const messages = threadStore.getThreadMessages(threadId).filter((m) => !m.superseded);

    if (messages.length < threshold) {
      return (
        `Conversation search is not needed yet — the active context window covers the full ` +
        `history (${messages.length} messages, threshold ${threshold}).`
      );
    }

    const corpus: { record: ThreadMessageRecord; text: string }[] = [];
    for (const msg of messages) {
      const text = extractText(msg);
      if (text) corpus.push({ record: msg, text });
    }

    if (corpus.length === 0) return 'No searchable content in conversation history.';

    const texts = corpus.map((c) => c.text);
    const resolvedLimit = limit ?? 5;

    const rankedIndices = await rankMessages(threadId, query, texts, resolvedLimit);

    if (rankedIndices.length === 0) return 'No relevant turns found for that query.';

    const results = rankedIndices.map(({ index, score }) => {
      const { record, text } = corpus[index]!;
      const excerpt = text.length > 600 ? text.slice(0, 600) + '…' : text;
      return {
        seq: record.seq,
        kind: record.kind,
        score: Math.round(score * 1000) / 1000,
        excerpt,
      };
    });

    return JSON.stringify(results, null, 2);
  },
  {
    name: 'search_conversation',
    description:
      'Search the conversation history for relevant past turns using semantic or keyword search. ' +
      'Use this when you need to recall information that has scrolled out of the active context window — ' +
      'for example, a wiki page you read many turns ago, or an instruction the user gave at the start of the session. ' +
      'Only available once the conversation reaches the configured length threshold. ' +
      'Returns the most relevant excerpts with their sequence numbers.',
    schema: SearchConversationSchema,
  },
);
