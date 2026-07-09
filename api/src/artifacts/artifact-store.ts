import { randomUUID } from 'node:crypto';

interface Artifact {
  buffer: Buffer;
  mimeType: string;
}

const store = new Map<string, Artifact>();

export function storeArtifact(buffer: Buffer, mimeType: string): string {
  const id = randomUUID();
  store.set(id, { buffer, mimeType });
  return id;
}

export function getArtifact(id: string): Artifact | undefined {
  return store.get(id);
}
