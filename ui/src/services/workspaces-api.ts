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
  threadId: string | null;
  summaryPath: string | null;
  lastSummarizedMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: string;
}

export interface CloseProgress {
  mergeSelections?: { filename: string; targetDomainId: string }[];
  dependencySelections?: { removeNodeModules: boolean; removePythonEnv: boolean };
}

export interface Project {
  id: string;
  workspaceId: string;
  winCondition: string;
  dueAt: string | null;
  status: 'active' | 'closing' | 'closed' | 'abandoned';
  closedAt: string | null;
  closeIntent: 'close' | 'abandon' | null;
  snapshotPath: string | null;
  closeProgress: CloseProgress | null;
}

export interface WorkspaceWithProject extends Workspace {
  project: Project;
}

export type LocationRoot = 'projects' | 'temporary';

export interface CreateWorkspaceInput {
  name: string;
  locationRoot: LocationRoot;
  directoryName: string;
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

// Distinct from CreateWorkspaceInput (which describes what a NEW workspace
// can be created with) since a patch can also set fields — threadId,
// summaryPath, lastSummarizedMessageId — that only ever change after
// creation, via the workspace-chat feature, never at creation time.
export interface PatchWorkspaceInput {
  name?: string;
  description?: string | null;
  goal?: string | null;
  remoteUrl?: string | null;
  javascript?: boolean;
  python?: boolean;
  git?: boolean;
  wikiId?: string | null;
  systemPrompt?: string | null;
  threadId?: string;
  summaryPath?: string;
  lastSummarizedMessageId?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
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

export async function patchWorkspace(id: string, patch: PatchWorkspaceInput): Promise<Workspace> {
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

export async function createProject(
  input: CreateProjectInput,
): Promise<{ workspace: Workspace; project: Project }> {
  return request<{ workspace: Workspace; project: Project }>('/api/v1/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchProject(
  id: string,
  patch: Partial<CreateProjectInput> & { closeProgress?: CloseProgress },
): Promise<WorkspaceWithProject> {
  return request<WorkspaceWithProject>(`/api/v1/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function closeProject(id: string, intent: 'close' | 'abandon'): Promise<Project> {
  return request<Project>(`/api/v1/projects/${id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent }),
  });
}

export async function snapshotProject(id: string): Promise<{ snapshotPath: string }> {
  return request<{ snapshotPath: string }>(`/api/v1/projects/${id}/snapshot`, { method: 'POST' });
}

export interface CleanupDependenciesInput {
  removeNodeModules: boolean;
  removePythonEnv: boolean;
  dryRun?: boolean;
}

export type CleanupDependenciesResult =
  | { dryRun: true; candidates: { path: string; sizeBytes: number }[] }
  | { dryRun: false; removed: string[]; bytesFreed: number };

export async function cleanupDependencies(
  workspaceId: string,
  input: CleanupDependenciesInput,
): Promise<CleanupDependenciesResult> {
  return request<CleanupDependenciesResult>(
    `/api/v1/workspaces/${workspaceId}/cleanup-dependencies`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export interface CompleteCloseResult {
  succeeded: string[];
  failed: { filename: string; error: string }[];
}

export async function completeCloseProject(id: string): Promise<CompleteCloseResult> {
  return request<CompleteCloseResult>(`/api/v1/projects/${id}/complete-close`, {
    method: 'POST',
  });
}
