import { request } from '@/utils/fetch.utils';

export interface RoleConfig {
  provider?: string;
  model?: string;
  systemPrompt?: string;
}

export interface Role extends RoleConfig {
  name: string;
}

export interface RolesListResponse {
  roles: Role[];
  defaultRole: string | null;
}

export async function fetchRoles(): Promise<RolesListResponse> {
  return request<RolesListResponse>('/api/v1/roles');
}

export async function createRole(name: string, fields: RoleConfig): Promise<Role> {
  return request<Role>('/api/v1/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...fields }),
  });
}

// A field omitted from `patch` leaves it unchanged; an explicit `null`
// clears it (resets to inheriting the system default); a string sets it.
export interface RolePatch {
  name?: string;
  provider?: string | null;
  model?: string | null;
  systemPrompt?: string | null;
}

export async function patchRole(name: string, patch: RolePatch): Promise<Role> {
  return request<Role>(`/api/v1/roles/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// Unlike deleteMcpServer's raw-fetch workaround, this endpoint returns 200
// with a body (not 204), so the shared request() helper's unconditional
// res.json() call works fine here — errors surface properly.
export async function deleteRole(name: string): Promise<{ deleted: true }> {
  return request<{ deleted: true }>(`/api/v1/roles/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function setDefaultRole(name: string): Promise<{ defaultRole: string }> {
  return request<{ defaultRole: string }>('/api/v1/roles/default-role', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
