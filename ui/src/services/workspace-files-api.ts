import { request } from '@/utils/fetch.utils';

export interface FileNode {
  name: string;
  path: string; // relative to workspace root, forward-slash separated
  type: 'file' | 'dir';
  children?: FileNode[]; // only on type: 'dir'
  gitStatus?: 'M' | 'A'; // only on type: 'file', only when the workspace has git enabled
  category?: 'text' | 'image' | 'audio' | 'video' | 'unsupported'; // only on type: 'file'
  oversize?: boolean; // only on type: 'file' — true only for category: 'text' over the size cap
  content?: string; // only on type: 'file' — ready-to-use content URL
}

export interface FileTreeResponse {
  branch: string | null;
  entries: FileNode[];
}

// Carries the HTTP status alongside the message so callers (openFile) can
// distinguish the 422 binary/oversized case from any other fetch failure
// without re-parsing anything.
export class FileFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'FileFetchError';
  }
}

export async function fetchFileTree(workspaceId: string): Promise<FileTreeResponse> {
  return request<FileTreeResponse>(`/api/v1/workspaces/${workspaceId}/files`);
}

function unquoteETag(value: string | null): string {
  return value ? value.replace(/^"|"$/g, '') : '';
}

export interface FileContentWithHash {
  content: string;
  contentHash: string;
}

// The file-content endpoint responds with text/plain, not JSON — this can't
// reuse the request<T> helper above (or workspaces-api.ts's), which always
// calls .json(). The hash rides in the ETag header rather than the body: it
// has to work uniformly for this plain-text response, with no restructuring
// needed to carry a second field.
export async function fetchFileContent(contentUrl: string): Promise<FileContentWithHash> {
  const res = await fetch(contentUrl, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')) as string;
    let message: string | undefined;
    try {
      message = (JSON.parse(body) as { error?: string }).error;
    } catch {
      // body wasn't JSON — fall through to the generic status message
    }
    throw new FileFetchError(message ?? `Request failed: ${res.status}`, res.status);
  }
  const contentHash = unquoteETag(res.headers.get('ETag'));
  return { content: await res.text(), contentHash };
}

// Thrown specifically on a 409 (the current on-disk content no longer
// matches the baseHash the client loaded) — distinct from FileFetchError so
// callers can show the conflict banner instead of a generic save-failure
// message.
export class SaveConflictError extends Error {
  constructor(
    message: string,
    public readonly currentHash: string,
  ) {
    super(message);
    this.name = 'SaveConflictError';
  }
}

export async function saveFile(
  contentUrl: string,
  content: string,
  baseHash: string,
  force = false,
): Promise<{ contentHash: string }> {
  const res = await fetch(contentUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseHash, force }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; currentHash?: string };
    throw new SaveConflictError(body.error ?? 'Save conflict', body.currentHash ?? '');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new FileFetchError(body.error ?? `Request failed: ${res.status}`, res.status);
  }
  const body = (await res.json()) as { ok: true; contentHash: string };
  return { contentHash: body.contentHash };
}

export type UploadResult =
  { ok: true; created: string[] } | { ok: false; error: string; conflicts?: string[] };

// Doesn't reuse request<T>() — a multipart body needs no Content-Type header
// (the browser sets its own boundary), and a conflict response is returned
// rather than thrown so the tree UI can render it inline.
export async function uploadFiles(
  workspaceId: string,
  dir: string,
  files: FileList | File[],
): Promise<UploadResult> {
  const formData = new FormData();
  for (const file of Array.from(files)) formData.append('files', file);

  const res = await fetch(
    `/api/v1/workspaces/${workspaceId}/files/upload?dir=${encodeURIComponent(dir)}`,
    { method: 'POST', body: formData },
  );
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    created?: string[];
    conflicts?: string[];
  };
  if (!res.ok) {
    return {
      ok: false,
      error: body.error ?? `Upload failed: ${res.status}`,
      conflicts: body.conflicts,
    };
  }
  return { ok: true, created: body.created ?? [] };
}

export type CreateEntryResult = { ok: true; path: string } | { ok: false; error: string };

async function createEntry(
  workspaceId: string,
  kind: 'file' | 'directory',
  dir: string,
  name: string,
): Promise<CreateEntryResult> {
  const res = await fetch(`/api/v1/workspaces/${workspaceId}/files/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir, name }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; path?: string };
  if (!res.ok) {
    return { ok: false, error: body.error ?? `Request failed: ${res.status}` };
  }
  return { ok: true, path: body.path ?? name };
}

export async function createDirectory(
  workspaceId: string,
  dir: string,
  name: string,
): Promise<CreateEntryResult> {
  return createEntry(workspaceId, 'directory', dir, name);
}

export async function createFile(
  workspaceId: string,
  dir: string,
  name: string,
): Promise<CreateEntryResult> {
  return createEntry(workspaceId, 'file', dir, name);
}

export type DeleteEntryResult = { ok: true } | { ok: false; error: string };

export async function deleteFileEntry(
  workspaceId: string,
  path: string,
): Promise<DeleteEntryResult> {
  // Each path segment is encoded independently (mirrors
  // workspace-files.ts's attachContentUrls on the backend) so the server's
  // wildcard route still sees literal "/" separators between segments.
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const res = await fetch(`/api/v1/workspaces/${workspaceId}/files/${encodedPath}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `Delete failed: ${res.status}` };
  }
  return { ok: true };
}
