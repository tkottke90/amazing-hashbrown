// Standalone types mirroring api/src/services/tool-settings-store.ts's
// ToolSettingRow shape (ui/ has no dependency on the api package — same
// rationale as mcp-servers-api.ts's McpServerConfig mirror).
export type ToolCategory = 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
export type ToolStatus = 'connected' | 'unreachable';

export interface ToolSettingItem {
  toolId: string;
  name: string;
  description: string;
  category: ToolCategory;
  enabled: boolean;
  defaultInclude: boolean;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: ToolStatus | null;
  updatedAt: string;
}

export interface ThreadToolItem extends ToolSettingItem {
  selected: boolean;
}

export interface ThreadToolsResponse {
  customized: boolean;
  tools: ThreadToolItem[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---- Global (Settings > Tools) --------------------------------------------

export async function fetchToolSettings(): Promise<ToolSettingItem[]> {
  return request<ToolSettingItem[]>('/api/v1/tool-settings');
}

export async function patchToolSetting(
  toolId: string,
  patch: { enabled?: boolean; defaultInclude?: boolean },
): Promise<ToolSettingItem> {
  return request<ToolSettingItem>(`/api/v1/tool-settings/${encodeURIComponent(toolId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// Explicit user action only (a "Refresh" button) — never called just from a
// page mounting, same principle as the MCP servers panel's "Check" button.
export async function refreshToolSettings(): Promise<ToolSettingItem[]> {
  return request<ToolSettingItem[]>('/api/v1/tool-settings/refresh', { method: 'POST' });
}

// ---- Per-thread (Edit Tools drawer) ----------------------------------------

export async function fetchThreadTools(threadId: string): Promise<ThreadToolsResponse> {
  return request<ThreadToolsResponse>(`/api/v1/threads/${encodeURIComponent(threadId)}/tools`);
}

export async function putThreadTools(
  threadId: string,
  toolIds: string[],
): Promise<ThreadToolsResponse> {
  return request<ThreadToolsResponse>(`/api/v1/threads/${encodeURIComponent(threadId)}/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolIds }),
  });
}

export async function resetThreadTools(threadId: string): Promise<ThreadToolsResponse> {
  return request<ThreadToolsResponse>(`/api/v1/threads/${encodeURIComponent(threadId)}/tools`, {
    method: 'DELETE',
  });
}
