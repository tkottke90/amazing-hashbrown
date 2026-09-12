import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Loader2 } from 'lucide-preact';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useTitle } from '@/hooks/use-title';
import { showToast } from '@/lib/toast';
import { McpServerDrawer } from './mcp-server-drawer';
import {
  fetchMcpServers,
  createMcpServer,
  patchMcpServer,
  deleteMcpServer,
  testExistingMcpServer,
  type McpServer,
  type McpServerConfig,
} from '@/services/mcp-servers-api';

type CheckStatus =
  | { status: 'checking' }
  | { status: 'success'; toolCount: number }
  | { status: 'error'; message: string };

export function McpServersPanel() {
  useTitle('Settings - MCP Servers');

  const servers = useSignal<McpServer[]>([]);
  const loading = useSignal(true);
  const loadError = useSignal<string | null>(null);
  const checkStatus = useSignal<Record<string, CheckStatus | undefined>>({});

  async function refresh() {
    servers.value = await fetchMcpServers();
  }

  useEffect(() => {
    refresh()
      .catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : 'Failed to load MCP servers';
      })
      .finally(() => {
        loading.value = false;
      });
  }, []);

  async function handleToggleEnabled(server: McpServer, next: boolean) {
    try {
      await patchMcpServer(server.name, { enabled: next });
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to update server');
    }
  }

  async function handleCheck(server: McpServer) {
    checkStatus.value = { ...checkStatus.value, [server.name]: { status: 'checking' } };
    try {
      const result = await testExistingMcpServer(server.name, server.config);
      checkStatus.value = {
        ...checkStatus.value,
        [server.name]: { status: 'success', toolCount: result.tools.length },
      };
    } catch (err) {
      checkStatus.value = {
        ...checkStatus.value,
        [server.name]: {
          status: 'error',
          message: err instanceof Error ? err.message : 'Test failed',
        },
      };
    }
  }

  async function handleRemove(server: McpServer) {
    if (!confirm(`Remove MCP server "${server.name}"? This cannot be undone.`)) return;
    try {
      await deleteMcpServer(server.name);
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove server');
    }
  }

  async function handleSaveAdd(name: string, config: McpServerConfig) {
    await createMcpServer(name, config);
    await refresh();
    showToast('success', `MCP server "${name}" added`);
  }

  async function handleSaveEdit(name: string, config: McpServerConfig) {
    await patchMcpServer(name, config);
    await refresh();
    showToast('success', `MCP server "${name}" updated`);
  }

  if (loadError.value) {
    return <div class="p-6 text-sm text-destructive">{loadError.value}</div>;
  }

  if (loading.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader class="flex flex-row items-center justify-between">
            <CardTitle>MCP Servers</CardTitle>
            <McpServerDrawer
              mode="add"
              onSave={handleSaveAdd}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  Add server
                </Button>
              }
            />
          </CardHeader>
          <CardContent>
            {servers.value.length === 0 ? (
              <p class="py-4 text-center text-sm text-muted-foreground">
                No MCP servers configured. Add one to get started.
              </p>
            ) : (
              <ul class="divide-y divide-border">
                {servers.value.map((server) => {
                  const status = checkStatus.value[server.name];
                  return (
                    <li
                      key={server.name}
                      data-slot="mcp-server-row"
                      class="flex flex-col gap-2 py-3"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2">
                          <span data-slot="mcp-server-row-name" class="text-sm font-medium">
                            {server.name}
                          </span>
                          <span
                            data-slot="mcp-server-row-transport"
                            class="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                          >
                            {server.config.transport ?? 'stdio'}
                          </span>
                        </div>
                        <div class="flex items-center gap-2">
                          <Switch
                            checked={server.config.enabled ?? true}
                            onCheckedChange={(v) => void handleToggleEnabled(server, v)}
                            aria-label={`Enable ${server.name}`}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleCheck(server)}
                            disabled={status?.status === 'checking'}
                          >
                            {status?.status === 'checking' && (
                              <Loader2 class="size-3.5 animate-spin" />
                            )}
                            Check
                          </Button>
                          <McpServerDrawer
                            mode="edit"
                            initial={server}
                            onSave={handleSaveEdit}
                            trigger={
                              <Button type="button" variant="ghost" size="sm">
                                Edit
                              </Button>
                            }
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="text-destructive hover:text-destructive"
                            onClick={() => void handleRemove(server)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                      <p class="text-xs text-muted-foreground">
                        {!status && 'Not checked'}
                        {status?.status === 'checking' && 'Checking…'}
                        {status?.status === 'success' &&
                          `Connected — ${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}`}
                        {status?.status === 'error' && (
                          <span class="text-destructive">Error: {status.message}</span>
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
