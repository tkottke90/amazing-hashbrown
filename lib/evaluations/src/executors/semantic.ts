import type { Embeddings } from '@langchain/core/embeddings';
import type { SemanticScenario } from '../schemas.js';

interface SemanticDetails {
  type: 'semantic';
  similarity: number;
  threshold: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function runSemantic(
  scenario: SemanticScenario,
  actualOutput: string,
  embeddings: Embeddings,
): Promise<SemanticDetails> {
  const [outputVec, expectedVec] = await Promise.all([
    embeddings.embedQuery(actualOutput),
    embeddings.embedQuery(scenario.expectedSimilarTo),
  ]);
  const similarity = cosineSimilarity(outputVec, expectedVec);
  return { type: 'semantic', similarity, threshold: scenario.minSimilarity };
}
