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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
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
