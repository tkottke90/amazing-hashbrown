export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  location: string;
  remoteUrl: string | null;
  javascript: boolean;
  python: boolean;
  git: boolean;
  wikiId: string | null;
  systemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  winCondition: string;
  dueAt: string | null;
  status: 'active' | 'closed' | 'abandoned';
  closedAt: string | null;
}

export interface WorkspaceWithProject extends Workspace {
  project: Project;
}

export interface CreateWorkspaceInput {
  name: string;
  location: string;
  description?: string | null;
  goal?: string | null;
  remoteUrl?: string | null;
  javascript?: boolean;
  python?: boolean;
  git?: boolean;
  wikiId?: string | null;
}

export interface CreateProjectInput extends CreateWorkspaceInput {
  winCondition: string;
  dueAt?: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>('/api/v1/workspaces');
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  return request<Workspace>('/api/v1/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchWorkspace(id: string, patch: Partial<CreateWorkspaceInput>): Promise<Workspace> {
  return request<Workspace>(`/api/v1/workspaces/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await fetch(`/api/v1/workspaces/${id}`, { method: 'DELETE' });
}

export async function fetchProjects(): Promise<WorkspaceWithProject[]> {
  return request<WorkspaceWithProject[]>('/api/v1/projects');
}

export async function createProject(input: CreateProjectInput): Promise<{ workspace: Workspace; project: Project }> {
  return request<{ workspace: Workspace; project: Project }>('/api/v1/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchProject(id: string, patch: Partial<CreateProjectInput>): Promise<WorkspaceWithProject> {
  return request<WorkspaceWithProject>(`/api/v1/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function closeProject(id: string): Promise<Project> {
  return request<Project>(`/api/v1/projects/${id}/close`, { method: 'POST' });
}
