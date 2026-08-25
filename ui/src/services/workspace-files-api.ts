export interface FileNode {
  name: string;
  path: string; // relative to workspace root, forward-slash separated
  type: 'file' | 'dir';
  children?: FileNode[]; // only on type: 'dir'
  gitStatus?: 'M' | 'A'; // only on type: 'file', only when the workspace has git enabled
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

function encodePath(relativePath: string): string {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
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

export async function fetchFileContent(workspaceId: string, path: string): Promise<string> {
  return requestText(`/api/v1/workspaces/${workspaceId}/files/${encodePath(path)}`);
}

export async function saveFile(workspaceId: string, path: string, content: string): Promise<void> {
  await request<{ ok: true }>(`/api/v1/workspaces/${workspaceId}/files/${encodePath(path)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}
