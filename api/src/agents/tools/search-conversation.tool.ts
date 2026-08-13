import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getThreadStore, type ThreadMessageRecord } from '../../services/thread-store.js';

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

function extractText(msg: ThreadMessageRecord): string | null {
  const payload = msg.payload as Record<string, unknown> | null;
  if (!payload) return null;

  switch (msg.kind) {
    case 'user':
    case 'assistant': {
      const content = payload['content'];
      if (typeof content === 'string' && content.trim()) return content.trim();
      break;
    }
    case 'tool_call': {
      const name = String(payload['name'] ?? '');
      const result = payload['result'] ?? payload['error'] ?? '';
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      return `Tool: ${name}\nResult: ${resultStr}`.trim();
    }
  }
  return null;
}

function keywordSearch(
  query: string,
  texts: string[],
  limit: number,
): { index: number; score: number }[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const scores = texts.map((text, index) => {
    const lower = text.toLowerCase();
    const score = terms.reduce((sum, term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = lower.match(new RegExp(escaped, 'g'));
      return sum + (matches?.length ?? 0);
    }, 0);
    return { index, score };
  });

  return scores
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let _embeddingProvider: EmbeddingAdapter | undefined;

function getEmbeddingProvider(): EmbeddingAdapter | undefined {
  if (!env.embeddings.enabled) return undefined;
  if (_embeddingProvider) return _embeddingProvider;

  if (env.embeddings.type === 'openai') {
    _embeddingProvider = new OpenAIEmbeddingProvider({
      apiKey: env.embeddings.apiKey,
      baseURL: env.embeddings.baseUrl,
      model: env.embeddings.model,
    });
  } else {
    _embeddingProvider = new OllamaEmbeddingProvider({
      baseUrl: env.embeddings.baseUrl,
      model: env.embeddings.model,
    });
  }
  return _embeddingProvider;
}

interface EmbeddingCache {
  messageCount: number;
  embeddings: number[][];
}

const _embeddingCache = new Map<string, EmbeddingCache>();

async function getCorpusEmbeddings(threadId: string, texts: string[]): Promise<number[][] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  const cached = _embeddingCache.get(threadId);
  if (cached && cached.messageCount === texts.length) {
    return cached.embeddings;
  }

  try {
    const embeddings = await provider.embed(texts);
    _embeddingCache.set(threadId, { messageCount: texts.length, embeddings });
    return embeddings;
  } catch (err) {
    logger.warn('search_conversation: embedding failed, falling back to keyword search', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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
    const messages = threadStore.getThreadMessages(threadId, { showErrors: false });

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

    const corpusEmbeddings = await getCorpusEmbeddings(threadId, texts);

    let rankedIndices: { index: number; score: number }[];

    if (corpusEmbeddings) {
      const provider = getEmbeddingProvider()!;
      let queryVec: number[] | null = null;
      try {
        const [vec] = await provider.embed([query]);
        queryVec = vec ?? null;
      } catch {
        queryVec = null;
      }

      if (queryVec) {
        rankedIndices = texts
          .map((_, i) => ({
            index: i,
            score: cosineSim(corpusEmbeddings[i]!, queryVec!),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, resolvedLimit);
      } else {
        rankedIndices = keywordSearch(query, texts, resolvedLimit);
      }
    } else {
      rankedIndices = keywordSearch(query, texts, resolvedLimit);
    }

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
