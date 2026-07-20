import {
  storeArtifact,
  getArtifactMeta,
  type ArtifactMeta,
} from '../../artifacts/artifact-store.js';
import { processImage } from '../../artifacts/image-processor.js';

// Plain, Express-agnostic handler functions — no req/res anywhere. The
// (untested, thin) artifacts.route.ts maps HandlerResult failures to HTTP
// status codes; Mocha tests call these directly with plain arguments. Same
// pattern as threads.handlers.ts.

export interface HandlerFailure {
  ok: false;
  status: 400 | 500;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function invalid(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

export interface UploadArtifactInput {
  mimeType: string;
  original: Buffer;
  threadId?: string;
  taskId?: string;
}

// Image mime types get processed into web/preview variants via sharp;
// everything else is stored as just the original bytes + meta.json.
export async function uploadArtifactHandler(
  input: UploadArtifactInput,
): Promise<HandlerResult<ArtifactMeta>> {
  let web: Buffer | undefined;
  let preview: Buffer | undefined;

  if (input.mimeType.startsWith('image/')) {
    try {
      ({ web, preview } = await processImage(input.original));
    } catch (err) {
      return invalid(
        `Failed to process image: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const id = await storeArtifact({
    mimeType: input.mimeType,
    original: input.original,
    web,
    preview,
    threadId: input.threadId,
    taskId: input.taskId,
  });

  const meta = getArtifactMeta(id);
  if (!meta) return serverError('Artifact was stored but metadata could not be read back');
  return ok(meta);
}
