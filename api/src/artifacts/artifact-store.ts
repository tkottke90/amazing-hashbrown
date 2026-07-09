import { randomUUID } from 'node:crypto';

export interface Artifact {
  mimeType: string; // original MIME type
  original: Buffer;
  web: Buffer; // WebP ≤1200px wide
  preview: Buffer; // 32px wide JPEG for blur-up
}

const store = new Map<string, Artifact>();

export function storeArtifact(artifact: Omit<Artifact, never>): string {
  const id = randomUUID();
  store.set(id, artifact);
  return id;
}

export function getArtifact(id: string): Artifact | undefined {
  return store.get(id);
}
