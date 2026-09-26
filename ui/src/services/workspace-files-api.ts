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

// The file-content endpoint responds with text/plain, not JSON — this can't
// reuse the request<T> helper above (or workspaces-api.ts's), which always
// calls .json().
async function requestText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
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
  return res.text();
}

export async function fetchFileTree(workspaceId: string): Promise<FileTreeResponse> {
  return request<FileTreeResponse>(`/api/v1/workspaces/${workspaceId}/files`);
}

export async function fetchFileContent(contentUrl: string): Promise<string> {
  return requestText(contentUrl);
}

export async function saveFile(contentUrl: string, content: string): Promise<void> {
  await request<{ ok: true }>(contentUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
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
