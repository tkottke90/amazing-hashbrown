import {
  storeArtifact,
  getArtifactMeta,
  deleteArtifact,
  type ArtifactMeta,
} from '../../artifacts/artifact-store.js';
import { processImage } from '../../artifacts/image-processor.js';
import { classifyArtifact } from '../../artifacts/artifact-classifier.js';

// Plain, Express-agnostic handler functions — no req/res anywhere. The
// (untested, thin) artifacts.route.ts maps HandlerResult failures to HTTP
// status codes; Mocha tests call these directly with plain arguments. Same
// pattern as threads.handlers.ts.

export interface HandlerFailure {
  ok: false;
  status: 400 | 403 | 404 | 500;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function invalid(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function forbidden(error: string): HandlerFailure {
  return { ok: false, status: 403, error };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_NON_IMAGE_MIME_TYPES = new Set([
  'application/pdf',
  DOCX_MIME_TYPE,
  'application/json',
  'application/yaml',
]);

// The client's file-picker `accept` attribute is a UX nicety only — a
// multipart upload can carry any MIME type regardless of what the picker
// suggested, so this is the real gate. `text/*` is accepted wholesale:
// nothing about being served as text/* implies a format needs special
// parsing, it's always safe to decode as UTF-8 (see classifyArtifact).
function isAllowedMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('text/') ||
    ALLOWED_NON_IMAGE_MIME_TYPES.has(mimeType)
  );
}

const EXTENSION_MIME_FALLBACK: Record<string, string> = {
  yaml: 'application/yaml',
  yml: 'application/yaml',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

// Browsers report YAML particularly inconsistently (application/x-yaml,
// text/yaml, text/x-yaml, or a generic/empty type depending on OS) since it
// has no single universally-registered MIME type — normalize every variant
// to one canonical value so everything downstream (classifyArtifact, the
// allow-list) only ever has to handle 'application/yaml'.
const YAML_MIME_ALIASES = new Set(['application/x-yaml', 'text/yaml', 'text/x-yaml']);

// Resolves what the upload should actually be treated as, correcting for
// two distinct browser quirks: an outright wrong-but-recognized YAML alias,
// and a generic/empty type the browser falls back to when it doesn't
// recognize the extension at all (chiefly YAML, but also covers any
// extension the browser's own MIME database doesn't know). Only overrides
// the reported type for the specific extensions listed above — this is not
// a blanket "trust any extension" fallback.
export function resolveEffectiveMimeType(reportedMimeType: string, filename: string): string {
  if (YAML_MIME_ALIASES.has(reportedMimeType)) return 'application/yaml';

  if (reportedMimeType && reportedMimeType !== 'application/octet-stream') {
    return reportedMimeType;
  }

  const ext = filename.split('.').pop()?.toLowerCase();
  return (ext && EXTENSION_MIME_FALLBACK[ext]) || reportedMimeType;
}

export interface UploadArtifactInput {
  mimeType: string;
  original: Buffer;
  displayFilename?: string;
  threadId?: string;
  taskId?: string;
}

// Image mime types get processed into web/preview variants via sharp;
// every allowed type (image or document) is also classified once here —
// requiresVision + any extracted text — so neither the capability-warning
// UI nor the send-time vision-gate ever has to re-process the file.
export async function uploadArtifactHandler(
  input: UploadArtifactInput,
): Promise<HandlerResult<ArtifactMeta>> {
  const effectiveMimeType = resolveEffectiveMimeType(input.mimeType, input.displayFilename ?? '');

  if (!isAllowedMimeType(effectiveMimeType)) {
    return invalid(`Unsupported file type: "${effectiveMimeType}"`);
  }

  let web: Buffer | undefined;
  let preview: Buffer | undefined;

  if (effectiveMimeType.startsWith('image/')) {
    try {
      ({ web, preview } = await processImage(input.original));
    } catch (err) {
      return invalid(
        `Failed to process image: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let requiresVision: boolean;
  let extractedText: string | null;
  try {
    ({ requiresVision, extractedText } = await classifyArtifact(effectiveMimeType, input.original));
  } catch (err) {
    return invalid(`Failed to process file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const id = await storeArtifact({
    mimeType: effectiveMimeType,
    original: input.original,
    web,
    preview,
    displayFilename: input.displayFilename,
    requiresVision,
    extractedText: extractedText ?? undefined,
    threadId: input.threadId,
    taskId: input.taskId,
  });

  const meta = getArtifactMeta(id);
  if (!meta) return serverError('Artifact was stored but metadata could not be read back');
  return ok(meta);
}

// Restricted to origin === 'user-upload' — an 'agent-generated' artifact
// (e.g. one upload_image created) can never be deleted through this route,
// regardless of who calls it.
export async function deleteArtifactHandler(id: string): Promise<HandlerResult<void>> {
  const meta = getArtifactMeta(id);
  if (!meta) return notFound(`Artifact "${id}" not found`);
  if (meta.origin !== 'user-upload') {
    return forbidden(`Artifact "${id}" is not a user upload and cannot be deleted here`);
  }
  await deleteArtifact(id);
  return ok(undefined);
}
