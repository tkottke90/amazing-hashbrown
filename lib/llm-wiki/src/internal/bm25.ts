/** In-memory BM25 scorer. Pure — no filesystem access, no external dependencies. */

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function termFrequency(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of terms) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

export interface BM25Doc {
  path: string;
  text: string;
}

export interface BM25Result {
  path: string;
  score: number;
}

export function bm25Score(queryTerms: string[], docs: BM25Doc[]): BM25Result[] {
  if (docs.length === 0 || queryTerms.length === 0) return [];

  const tokenizedDocs = docs.map((d) => tokenize(d.text));
  const avgdl = tokenizedDocs.reduce((s, t) => s + t.length, 0) / tokenizedDocs.length;

  // IDF: log((N - df + 0.5) / (df + 0.5) + 1) — clamped to 0
  const df = new Map<string, number>();
  for (const terms of tokenizedDocs) {
    for (const t of new Set(terms)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const N = docs.length;
  const idf = (term: string): number => {
    const d = df.get(term) ?? 0;
    return Math.max(0, Math.log((N - d + 0.5) / (d + 0.5) + 1));
  };

  const scores = tokenizedDocs.map((docTerms, i) => {
    const tf = termFrequency(docTerms);
    const dl = docTerms.length;
    let score = 0;
    for (const qt of queryTerms) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      const numerator = f * (K1 + 1);
      const denominator = f + K1 * (1 - B + B * (dl / avgdl));
      score += idf(qt) * (numerator / denominator);
    }
    return { path: docs[i]!.path, score };
  });

  // Normalize scores to [0, 1]
  const max = Math.max(...scores.map((s) => s.score), 0);
  if (max === 0) return scores;
  return scores.map((s) => ({ ...s, score: s.score / max }));
}
