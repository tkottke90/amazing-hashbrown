import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface Artifact {
  mimeType: string; // original MIME type
  original: Buffer;
  web: Buffer; // WebP ≤1200px wide
  preview: Buffer; // 32px wide JPEG for blur-up
}

export type ArtifactOrigin = 'user-upload' | 'agent-generated';

export interface ArtifactMeta {
  id: string;
  mimeType: string;
  originalFilename: string;
  origin: ArtifactOrigin;
  threadId: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface NewArtifactInput {
  mimeType: string;
  original: Buffer;
  web: Buffer;
  preview: Buffer;
  origin?: ArtifactOrigin;
  threadId?: string;
  taskId?: string;
}

const WEB_FILENAME = 'web.webp';
const PREVIEW_FILENAME = 'preview.jpg';
const META_FILENAME = 'meta.json';

// In-memory index of metadata only — hydrated from disk on boot, kept in
// sync on every write. File bytes are always read from disk on demand.
const index = new Map<string, ArtifactMeta>();

function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0] ?? 'bin';
  const overrides: Record<string, string> = { jpeg: 'jpg', 'svg+xml': 'svg' };
  const cleaned = overrides[subtype] ?? subtype.replace(/[^a-z0-9]/gi, '');
  return cleaned || 'bin';
}

let currentRoot: string | null = null;

function getRoot(): string {
  if (!currentRoot) {
    throw new Error('Artifact store not initialised — call bootArtifactStore() first');
  }
  return currentRoot;
}

function artifactDir(id: string): string {
  return path.join(getRoot(), id);
}

/** Scan the artifact root and hydrate the in-memory metadata index. */
export async function bootArtifactStore(root: string = env.artifactRoot): Promise<void> {
  currentRoot = root;
  index.clear();
  await mkdir(currentRoot, { recursive: true });

  const entries = await readdir(currentRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(path.join(currentRoot, entry.name, META_FILENAME), 'utf-8');
      const meta = JSON.parse(raw) as ArtifactMeta;
      index.set(meta.id, meta);
    } catch (err) {
      logger.warn('Skipping unreadable artifact directory', {
        id: entry.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info(`Artifact store hydrated (${index.size} artifact(s))`);
}

export async function storeArtifact(input: NewArtifactInput): Promise<string> {
  const id = randomUUID();
  const meta: ArtifactMeta = {
    id,
    mimeType: input.mimeType,
    originalFilename: `original.${extensionForMimeType(input.mimeType)}`,
    origin: input.origin ?? 'user-upload',
    threadId: input.threadId ?? null,
    taskId: input.taskId ?? null,
    createdAt: new Date().toISOString(),
  };

  const dir = artifactDir(id);
  await mkdir(dir, { recursive: true });
  // Buffer -> Uint8Array: works around a Buffer/Uint8Array<ArrayBufferLike>
  // generic type mismatch between TS 5.9's stricter typed-array lib and
  // @types/node@20's Buffer typings — no-op at runtime (Buffer already is one).
  await Promise.all([
    writeFile(path.join(dir, meta.originalFilename), new Uint8Array(input.original)),
    writeFile(path.join(dir, WEB_FILENAME), new Uint8Array(input.web)),
    writeFile(path.join(dir, PREVIEW_FILENAME), new Uint8Array(input.preview)),
    writeFile(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2)),
  ]);

  index.set(id, meta);
  return id;
}

/** Metadata only, from the in-memory index — no disk read. */
export function getArtifactMeta(id: string): ArtifactMeta | undefined {
  return index.get(id);
}

export async function getArtifact(id: string): Promise<Artifact | undefined> {
  const meta = index.get(id);
  if (!meta) return undefined;

  const dir = artifactDir(id);
  const [original, web, preview] = await Promise.all([
    readFile(path.join(dir, meta.originalFilename)),
    readFile(path.join(dir, WEB_FILENAME)),
    readFile(path.join(dir, PREVIEW_FILENAME)),
  ]);

  return { mimeType: meta.mimeType, original, web, preview };
}
