/** Persistent embedding index — stores vec + sha per page in _embeddings.json. */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const EMBEDDING_INDEX_FILE = '_embeddings.json';

interface IndexEntry {
  sha: string;
  vec: number[];
}

interface IndexFile {
  model: string;
  version: 1;
  entries: Record<string, IndexEntry>;
}

export class EmbeddingIndex {
  private constructor(
    private data: IndexFile,
  ) {}

  static async load(basePath: string, model: string): Promise<EmbeddingIndex> {
    const target = path.join(basePath, EMBEDDING_INDEX_FILE);
    try {
      const raw = await fs.readFile(target, 'utf8');
      const parsed = JSON.parse(raw) as IndexFile;
      // Invalidate the whole index if the model changed.
      if (parsed.model !== model) {
        return new EmbeddingIndex({ model, version: 1, entries: {} });
      }
      return new EmbeddingIndex(parsed);
    } catch {
      return new EmbeddingIndex({ model, version: 1, entries: {} });
    }
  }

  needsUpdate(relPath: string, sha: string): boolean {
    const entry = this.data.entries[relPath];
    return entry === undefined || entry.sha !== sha;
  }

  set(relPath: string, sha: string, vec: number[]): void {
    this.data.entries[relPath] = { sha, vec };
  }

  remove(relPath: string): void {
    delete this.data.entries[relPath];
  }

  getAll(): Array<{ relPath: string; sha: string; vec: number[] }> {
    return Object.entries(this.data.entries).map(([relPath, e]) => ({
      relPath,
      sha: e.sha,
      vec: e.vec,
    }));
  }

  get model(): string {
    return this.data.model;
  }

  async save(basePath: string): Promise<void> {
    const target = path.join(basePath, EMBEDDING_INDEX_FILE);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, target);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
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
