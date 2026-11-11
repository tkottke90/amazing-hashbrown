import { OllamaEmbeddingProvider, OpenAIEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// Shared ranking machinery for search_conversation (the caller's own live
// thread) and search_threads (any other thread it already knows the id
// of) — both tools do the exact same "try embeddings, cosine-rank, fall
// back to keyword search" branch over a corpus of extracted message
// texts, so it lives here once instead of twice.

export function keywordSearch(
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

export function cosineSim(a: number[], b: number[]): number {
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

export function getEmbeddingProvider(): EmbeddingAdapter | undefined {
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

// Keyed generically by whatever thread id a caller passes — search_threads
// extends this to arbitrary other threads with no change, since nothing
// here assumes "the caller's own thread." Unbounded across many distinct
// thread ids (no eviction); pre-existing characteristic of this cache, not
// a regression introduced by search_threads using it too.
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
    logger.warn('thread-search-ranking: embedding failed, falling back to keyword search', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Ranks `texts` against `query` for the given `threadId`'s embedding
// cache: embeddings + cosine similarity when an embedding provider is
// configured and both the corpus and the query embed successfully,
// otherwise plain keyword search. Returns the top `limit` by score,
// highest first.
export async function rankMessages(
  threadId: string,
  query: string,
  texts: string[],
  limit: number,
): Promise<{ index: number; score: number }[]> {
  const corpusEmbeddings = await getCorpusEmbeddings(threadId, texts);
  if (!corpusEmbeddings) return keywordSearch(query, texts, limit);

  const provider = getEmbeddingProvider()!;
  let queryVec: number[] | null = null;
  try {
    const [vec] = await provider.embed([query]);
    queryVec = vec ?? null;
  } catch {
    queryVec = null;
  }
  if (!queryVec) return keywordSearch(query, texts, limit);

  return texts
    .map((_, i) => ({ index: i, score: cosineSim(corpusEmbeddings[i]!, queryVec!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
