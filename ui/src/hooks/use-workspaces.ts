import { signal } from '@preact/signals';
import type { Workspace, WorkspaceWithProject } from '@/services/workspaces-api';
import {
  fetchWorkspaces,
  fetchProjects,
  createWorkspace as apiCreateWorkspace,
  createProject as apiCreateProject,
  patchWorkspace as apiPatchWorkspace,
  deleteWorkspace as apiDeleteWorkspace,
  closeProject as apiCloseProject,
  type CreateWorkspaceInput,
  type CreateProjectInput,
  type PatchWorkspaceInput,
} from '@/services/workspaces-api';

export const workspaces = signal<Workspace[]>([]);
export const projects = signal<WorkspaceWithProject[]>([]);
export const currentWorkspace = signal<Workspace | null>(null);
export const workspacesLoading = signal(false);

export async function refreshWorkspaces(): Promise<void> {
  workspacesLoading.value = true;
  try {
    const [ws, ps] = await Promise.all([fetchWorkspaces(), fetchProjects()]);
    workspaces.value = ws;
    projects.value = ps;
  } catch {
    // best-effort — stays stale until next successful refresh
  } finally {
    workspacesLoading.value = false;
  }
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const ws = await apiCreateWorkspace(input);
  workspaces.value = [ws, ...workspaces.value];
  return ws;
}

export async function createProject(input: CreateProjectInput): Promise<WorkspaceWithProject> {
  const { workspace, project } = await apiCreateProject(input);
  const entry: WorkspaceWithProject = { ...workspace, project };
  projects.value = [entry, ...projects.value];
  workspaces.value = [workspace, ...workspaces.value];
  return entry;
}

export async function patchWorkspace(id: string, patch: PatchWorkspaceInput): Promise<void> {
  const updated = await apiPatchWorkspace(id, patch);
  workspaces.value = workspaces.value.map((w) => (w.id === id ? updated : w));
  if (currentWorkspace.value?.id === id) currentWorkspace.value = updated;
}

export async function deleteWorkspace(id: string): Promise<void> {
  await apiDeleteWorkspace(id);
  workspaces.value = workspaces.value.filter((w) => w.id !== id);
  projects.value = projects.value.filter((p) => p.id !== id);
}

export async function closeProject(workspaceId: string): Promise<void> {
  await apiCloseProject(workspaceId);
  await refreshWorkspaces();
}

export function getProjectForWorkspace(workspaceId: string): WorkspaceWithProject | undefined {
  return projects.value.find((p) => p.id === workspaceId);
}

export function isProject(workspaceId: string): boolean {
  return projects.value.some((p) => p.id === workspaceId);
}
