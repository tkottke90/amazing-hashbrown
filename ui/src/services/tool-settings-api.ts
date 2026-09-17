// Standalone types mirroring api/src/agents/tool-config.ts's
// ResolvedToolSettingItem shape (ui/ has no dependency on the api package —
// same rationale as mcp-servers-api.ts's McpServerConfig mirror).
//
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §6/§7
export type ToolCategory = 'built-in' | 'wiki' | 'skill-gated' | 'mcp';
export type ToolStatus = 'connected' | 'unreachable';

export interface ToolDefaultInclude {
  chat: boolean;
  subAgent: boolean;
  autonomous: boolean;
}

export interface ToolSettingItem {
  toolId: string;
  name: string;
  description: string;
  category: ToolCategory;
  alwaysOn: boolean;
  mcpServer: string | null;
  lastSeenAt: string | null;
  lastStatus: ToolStatus | null;
  enabled: boolean;
  defaultInclude: ToolDefaultInclude;
  instructions: string;
  // web_fetch
  timeoutMs?: number;
  respectRobotsTxt?: boolean;
  // rlm_query
  provider?: string;
  model?: string;
  maxIterations?: number;
  truncateThreshold?: number;
  // shell_exec
  allowlist?: string[];
  denylist?: string[];
  env?: Record<string, string>;
}

export type ToolSettingPatch = Partial<
  Pick<ToolSettingItem, 'enabled' | 'description' | 'instructions'> & {
    defaultInclude: Partial<ToolDefaultInclude>;
  } & Pick<
      ToolSettingItem,
      | 'timeoutMs'
      | 'respectRobotsTxt'
      | 'provider'
      | 'model'
      | 'maxIterations'
      | 'truncateThreshold'
      | 'allowlist'
      | 'denylist'
      | 'env'
    >
>;

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

// Names only — the API never exposes env var values, so there is nothing
// here to accidentally render or log a secret from.
export async function fetchShellEnvVarNames(): Promise<string[]> {
  const res = await fetch('/api/v1/tool-settings/shell_exec/env-vars');
  if (!res.ok) throw new Error('Failed to fetch environment variable names');
  const data = (await res.json()) as { names: string[] };
  return data.names;
}

export async function fetchToolSettings(): Promise<ToolSettingItem[]> {
  return request<ToolSettingItem[]>('/api/v1/tool-settings');
}

export async function patchToolSetting(
  toolId: string,
  patch: ToolSettingPatch,
): Promise<ToolSettingItem> {
  return request<ToolSettingItem>(`/api/v1/tool-settings/${encodeURIComponent(toolId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// Reset Defaults — clears the tool's entire config.yaml entry.
export async function resetToolSetting(toolId: string): Promise<ToolSettingItem> {
  return request<ToolSettingItem>(`/api/v1/tool-settings/${encodeURIComponent(toolId)}`, {
    method: 'DELETE',
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
