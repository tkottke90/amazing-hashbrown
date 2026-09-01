export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  dirty: boolean;
}

export interface GitBranches {
  local: string[];
  remote: string[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchGitStatus(workspaceId: string): Promise<GitStatus> {
  return request<GitStatus>(`/api/v1/workspaces/${workspaceId}/git/status`);
}

export async function fetchGitBranches(workspaceId: string): Promise<GitBranches> {
  return request<GitBranches>(`/api/v1/workspaces/${workspaceId}/git/branches`);
}

export async function gitFetch(workspaceId: string): Promise<GitStatus> {
  return request<GitStatus>(`/api/v1/workspaces/${workspaceId}/git/fetch`, { method: 'POST' });
}

export async function gitSync(workspaceId: string): Promise<GitStatus> {
  return request<GitStatus>(`/api/v1/workspaces/${workspaceId}/git/sync`, { method: 'POST' });
}

export async function gitPush(workspaceId: string): Promise<GitStatus> {
  return request<GitStatus>(`/api/v1/workspaces/${workspaceId}/git/push`, { method: 'POST' });
}

export async function gitCheckout(workspaceId: string, branch: string): Promise<GitStatus> {
  return request<GitStatus>(`/api/v1/workspaces/${workspaceId}/git/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
}

export async function gitCreateBranch(
  workspaceId: string,
  name: string,
  from?: string,
): Promise<GitStatus> {
  return request<GitStatus>(`/api/v1/workspaces/${workspaceId}/git/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, from }),
  });
}
