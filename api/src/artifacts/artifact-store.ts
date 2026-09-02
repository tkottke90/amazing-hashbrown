import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface Artifact {
  mimeType: string; // original MIME type
  original: Buffer;
  web: Buffer | null; // WebP ≤1200px wide — null for non-image artifacts
  preview: Buffer | null; // 32px wide JPEG for blur-up — null for non-image artifacts
}

export type ArtifactOrigin = 'user-upload' | 'agent-generated';

export interface ArtifactMeta {
  id: string;
  mimeType: string;
  originalFilename: string;
  // The browser-supplied filename (e.g. "vacation.png"), for UI display.
  // Distinct from originalFilename above, which is always the synthesized
  // on-disk name derived from mimeType (e.g. "original.png") — that one
  // never changes, this one defaults to it when the caller doesn't supply
  // a real name (e.g. the agent-generated upload_image call site).
  displayFilename: string;
  // Whether web.webp/preview.jpg were written for this artifact. A stored
  // fact rather than re-derived from mimeType, so getArtifact() never has to
  // guess or risk reading files that were never written.
  hasVariants: boolean;
  // True when the file needs a vision-capable model to be meaningfully
  // consumed (raw images, and scanned/image-only PDFs with no extractable
  // text layer) — computed once at upload time by the classifier, not
  // re-derived on every send.
  requiresVision: boolean;
  // Whether a sibling text.txt was written (mirrors hasVariants above) —
  // the actual extracted text is never put on ArtifactMeta/meta.json
  // itself, only this boolean; read it on demand via getExtractedText().
  hasExtractedText: boolean;
  // Set once this artifact is actually used in a sent chat message
  // (regardless of whether it ended up included or excluded by the
  // vision-gate) — null means "still just staged, or truly orphaned",
  // which is what the GC sweep keys off.
  referencedAt: string | null;
  origin: ArtifactOrigin;
  threadId: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface NewArtifactInput {
  mimeType: string;
  original: Buffer;
  web?: Buffer;
  preview?: Buffer;
  displayFilename?: string;
  requiresVision?: boolean;
  extractedText?: string;
  origin?: ArtifactOrigin;
  threadId?: string;
  taskId?: string;
}

const WEB_FILENAME = 'web.webp';
const PREVIEW_FILENAME = 'preview.jpg';
const META_FILENAME = 'meta.json';
const TEXT_FILENAME = 'text.txt';

// In-memory index of metadata only — hydrated from disk on boot, kept in
// sync on every write. File bytes are always read from disk on demand.
const index = new Map<string, ArtifactMeta>();

function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0] ?? 'bin';
  const overrides: Record<string, string> = {
    jpeg: 'jpg',
    'svg+xml': 'svg',
    'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };
  const cleaned = overrides[subtype] ?? subtype.replace(/[^a-z0-9]/gi, '');
  return cleaned || 'bin';
}

function persistMeta(dir: string, meta: ArtifactMeta): Promise<void> {
  return writeFile(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2));
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
  const hasVariants = input.web !== undefined && input.preview !== undefined;
  const hasExtractedText = input.extractedText !== undefined;
  const originalFilename = `original.${extensionForMimeType(input.mimeType)}`;
  const meta: ArtifactMeta = {
    id,
    mimeType: input.mimeType,
    originalFilename,
    displayFilename: input.displayFilename ?? originalFilename,
    hasVariants,
    requiresVision: input.requiresVision ?? false,
    hasExtractedText,
    referencedAt: null,
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
  const writes = [
    writeFile(path.join(dir, meta.originalFilename), new Uint8Array(input.original)),
    persistMeta(dir, meta),
  ];
  if (hasVariants) {
    writes.push(
      writeFile(path.join(dir, WEB_FILENAME), new Uint8Array(input.web!)),
      writeFile(path.join(dir, PREVIEW_FILENAME), new Uint8Array(input.preview!)),
    );
  }
  if (hasExtractedText) {
    writes.push(writeFile(path.join(dir, TEXT_FILENAME), input.extractedText!, 'utf-8'));
  }
  await Promise.all(writes);

  index.set(id, meta);
  return id;
}

/** Metadata only, from the in-memory index — no disk read. */
export function getArtifactMeta(id: string): ArtifactMeta | undefined {
  return index.get(id);
}

/** Every artifact's metadata currently in the index — used by the GC sweep. */
export function listArtifactMeta(): ArtifactMeta[] {
  return [...index.values()];
}

/** Reads the sibling text.txt on demand; null if none was ever written. */
export async function getExtractedText(id: string): Promise<string | null> {
  const meta = index.get(id);
  if (!meta || !meta.hasExtractedText) return null;
  return readFile(path.join(artifactDir(id), TEXT_FILENAME), 'utf-8');
}

/**
 * Removes an artifact's directory and index entry. Returns false (rather
 * than throwing) for an unknown id. Callers are responsible for any
 * authorization check (e.g. restricting this to origin === 'user-upload')
 * — this primitive itself is unconditional, shared by the explicit DELETE
 * route and the orphaned-upload GC sweep so neither duplicates the other's
 * removal logic.
 */
export async function deleteArtifact(id: string): Promise<boolean> {
  if (!index.has(id)) return false;
  await rm(artifactDir(id), { recursive: true, force: true });
  index.delete(id);
  return true;
}

/**
 * Idempotent: only sets referencedAt the first time (never overwrites an
 * already-set value), and persists the change to meta.json — not just the
 * in-memory index — so it survives a restart. Without persisting this, a
 * server restart would make every previously-sent attachment look
 * orphaned again (the index is rehydrated from meta.json on boot), and
 * it would get garbage-collected once the grace period elapsed.
 */
export async function markArtifactReferenced(id: string, now: Date = new Date()): Promise<void> {
  const meta = index.get(id);
  if (!meta || meta.referencedAt !== null) return;
  meta.referencedAt = now.toISOString();
  await persistMeta(artifactDir(id), meta);
}

export async function getArtifact(id: string): Promise<Artifact | undefined> {
  const meta = index.get(id);
  if (!meta) return undefined;

  const dir = artifactDir(id);
  const original = await readFile(path.join(dir, meta.originalFilename));

  if (!meta.hasVariants) {
    return { mimeType: meta.mimeType, original, web: null, preview: null };
  }

  const [web, preview] = await Promise.all([
    readFile(path.join(dir, WEB_FILENAME)),
    readFile(path.join(dir, PREVIEW_FILENAME)),
  ]);

  return { mimeType: meta.mimeType, original, web, preview };
}
