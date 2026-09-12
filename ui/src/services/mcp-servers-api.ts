// Standalone types mirroring @tkottke90/tools-manager's McpServerConfig shape
// (ui/ has no dependency on that package — provider-modal.tsx's ProviderConfig
// is the established precedent for this).
export interface McpStdioConfig {
  transport?: 'stdio';
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  restart?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export interface McpHttpConfig {
  transport: 'http' | 'sse';
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  reconnect?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpServer {
  name: string;
  config: McpServerConfig;
}

// Standalone mirror of @tkottke90/tools-manager's McpCapabilities shape,
// same rationale as the config types above.
export interface McpCapabilities {
  tools: { name: string; description: string }[];
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  resourceTemplates: { uriTemplate: string; name: string; description?: string }[];
}

export type TestConnectionResult = McpCapabilities;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchMcpServers(): Promise<McpServer[]> {
  return request<McpServer[]>('/api/v1/mcp-servers');
}

export async function createMcpServer(name: string, config: McpServerConfig): Promise<McpServer> {
  return request<McpServer>('/api/v1/mcp-servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  });
}

export async function patchMcpServer(
  name: string,
  patch: Partial<McpServerConfig>,
): Promise<McpServer> {
  return request<McpServer>(`/api/v1/mcp-servers/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteMcpServer(name: string): Promise<void> {
  await fetch(`/api/v1/mcp-servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// The two test-connection calls follow providers-api.ts's testEmbeddings
// pattern rather than the request() helper above: the backend always
// responds 200 on success / (400 or 502) on failure with an explicit `ok`
// flag in the body itself (not just the HTTP status), and a failed
// connection attempt is thrown here so callers can catch it the same way
// they already catch any other rejected API call.
async function runConnectionTest(
  url: string,
  config: McpServerConfig,
): Promise<TestConnectionResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    tools?: McpCapabilities['tools'];
    resources?: McpCapabilities['resources'];
    resourceTemplates?: McpCapabilities['resourceTemplates'];
    error?: string;
  };

  if (!res.ok || !payload.ok || payload.tools == null) {
    throw new Error(payload.error ?? `Test failed: ${res.status}`);
  }

  return {
    tools: payload.tools,
    resources: payload.resources ?? [],
    resourceTemplates: payload.resourceTemplates ?? [],
  };
}

export async function testNewMcpServer(config: McpServerConfig): Promise<TestConnectionResult> {
  return runConnectionTest('/api/v1/mcp-servers/test', config);
}

export async function testExistingMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<TestConnectionResult> {
  return runConnectionTest(`/api/v1/mcp-servers/${encodeURIComponent(name)}/test`, config);
}
