import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Loader2 } from 'lucide-preact';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { KeyValueList } from '@/components/key-value-list';
import {
  testNewMcpServer,
  testExistingMcpServer,
  type McpServer,
  type McpServerConfig,
  type McpCapabilities,
} from '@/services/mcp-servers-api';
import type { JSX } from 'preact';

type Transport = 'stdio' | 'http' | 'sse';

interface McpServerDrawerProps {
  mode: 'add' | 'edit';
  initial?: McpServer;
  onSave: (name: string, config: McpServerConfig) => Promise<void>;
  trigger: JSX.Element;
}

function arrayToLines(arr?: string[]): string {
  return arr?.join('\n') ?? '';
}

function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function transportOf(config?: McpServerConfig): Transport {
  if (!config) return 'stdio';
  return config.transport ?? 'stdio';
}

export function McpServerDrawer({ mode, initial, onSave, trigger }: McpServerDrawerProps) {
  // Re-open counter, same reason as provider-modal.tsx: dialog children stay
  // mounted between opens, so form state needs an explicit reset hook.
  const openCount = useSignal(0);

  return (
    <Drawer
      title={mode === 'add' ? 'Add MCP server' : 'Edit MCP server'}
      side="right"
      className="w-[90vw]! sm:w-[32rem]! sm:max-w-[90vw]!"
      trigger={trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <McpServerForm mode={mode} initial={initial} onSave={onSave} openCount={openCount} />
    </Drawer>
  );
}

interface McpServerFormProps {
  mode: 'add' | 'edit';
  initial?: McpServer;
  onSave: (name: string, config: McpServerConfig) => Promise<void>;
  openCount: Signal<number>;
}

type CapabilitiesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: McpCapabilities };

function ToolRow({ name, description }: { name: string; description: string }) {
  return (
    <li class="flex flex-col gap-0.5 px-2 py-1.5">
      <span class="truncate text-sm font-medium text-foreground">{name}</span>
      <span class="truncate text-xs text-muted-foreground">{description}</span>
    </li>
  );
}

function ResourceRow({
  name,
  description,
  identifier,
}: {
  name: string;
  description?: string;
  identifier: string;
}) {
  return (
    <li class="flex flex-col gap-0.5 px-2 py-1.5">
      <span class="truncate text-sm font-medium text-foreground">{name}</span>
      {description && <span class="truncate text-xs text-muted-foreground">{description}</span>}
      <span class="truncate font-mono text-[11px] text-muted-foreground">{identifier}</span>
    </li>
  );
}

function McpCapabilitiesPanel({ state }: { state: CapabilitiesState }) {
  if (state.status === 'idle') {
    return (
      <p class="text-xs text-muted-foreground">
        Click Test connection to see what this server exposes.
      </p>
    );
  }

  if (state.status === 'loading') {
    return (
      <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 class="size-3.5 animate-spin" /> Checking…
      </p>
    );
  }

  if (state.status === 'error') {
    return <p class="text-xs text-destructive">{state.message}</p>;
  }

  const { tools, resources, resourceTemplates } = state.data;
  const resourceItems = [
    ...resources.map((r) => ({ name: r.name, description: r.description, identifier: r.uri })),
    ...resourceTemplates.map((r) => ({
      name: r.name,
      description: r.description,
      identifier: r.uriTemplate,
    })),
  ];

  return (
    <div class="space-y-3">
      <div>
        <p class="text-xs font-medium text-foreground">Tools</p>
        {tools.length === 0 ? (
          <p class="text-xs text-muted-foreground">No tools exposed.</p>
        ) : (
          <ul class="divide-y divide-border">
            {tools.map((tool) => (
              <ToolRow key={tool.name} name={tool.name} description={tool.description} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <p class="text-xs font-medium text-foreground">Resources</p>
        {resourceItems.length === 0 ? (
          <p class="text-xs text-muted-foreground">No resources exposed.</p>
        ) : (
          <ul class="divide-y divide-border">
            {resourceItems.map((r) => (
              <ResourceRow
                key={r.identifier}
                name={r.name}
                description={r.description}
                identifier={r.identifier}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function McpServerForm({ mode, initial, onSave, openCount }: McpServerFormProps) {
  const { close } = useDialog();

  // Dialog children stay mounted at all times regardless of open state (see
  // provider-modal.tsx's comment on the same pattern) — so with one Add
  // drawer plus one Edit drawer per row, every McpServerForm instance is
  // simultaneously present in the DOM. A static id here would duplicate
  // across instances and break <label for> association (the browser
  // resolves a duplicate id to a single element, silently detaching every
  // other same-id label from its real input). Suffix every id with an
  // instance-unique key instead.
  const instanceKey = mode === 'edit' && initial ? `edit-${initial.name}` : 'add';

  // Permissive read-only shape for seeding the form from either transport's
  // config. `McpStdioConfig & McpHttpConfig` collapses to `never` (their
  // `transport` fields have disjoint literal types), so this is a
  // hand-written union-of-fields type instead of an actual intersection.
  const initialConfig = initial?.config as
    | {
        enabled?: boolean;
        command?: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        restart?: { enabled?: boolean };
        url?: string;
        headers?: Record<string, string>;
        reconnect?: { enabled?: boolean };
      }
    | undefined;

  const name = useSignal(initial?.name ?? '');
  const transport = useSignal<Transport>(transportOf(initial?.config));
  const enabled = useSignal(initialConfig?.enabled ?? true);

  // stdio fields
  const command = useSignal(initialConfig?.command ?? '');
  const args = useSignal(arrayToLines(initialConfig?.args));
  const cwd = useSignal(initialConfig?.cwd ?? '');
  const env = useSignal<Record<string, string>>(initialConfig?.env ?? {});
  const restartEnabled = useSignal(initialConfig?.restart?.enabled ?? true);

  // http/sse fields
  const url = useSignal(initialConfig?.url ?? '');
  const headers = useSignal<Record<string, string>>(initialConfig?.headers ?? {});
  const reconnectEnabled = useSignal(initialConfig?.reconnect?.enabled ?? true);

  const capabilities = useSignal<CapabilitiesState>({ status: 'idle' });
  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  function buildConfig(): McpServerConfig {
    const currentTransport = transport.value;
    if (currentTransport === 'stdio') {
      return {
        transport: 'stdio',
        enabled: enabled.value,
        command: command.value.trim(),
        args: linesToArray(args.value),
        cwd: cwd.value.trim() || undefined,
        env: env.value,
        restart: { enabled: restartEnabled.value },
      };
    }
    return {
      transport: currentTransport,
      enabled: enabled.value,
      url: url.value.trim(),
      headers: headers.value,
      reconnect: { enabled: reconnectEnabled.value },
    };
  }

  async function handleTest() {
    capabilities.value = { status: 'loading' };
    try {
      const config = buildConfig();
      const result =
        mode === 'add'
          ? await testNewMcpServer(config)
          : await testExistingMcpServer(initial!.name, config);
      capabilities.value = { status: 'ready', data: result };
    } catch (err) {
      capabilities.value = {
        status: 'error',
        message: err instanceof Error ? err.message : 'Test failed',
      };
    }
  }

  // Fires once at mount and again each time the dialog is reopened, mirroring
  // provider-modal.tsx's ProviderForm — resets transient UI state (not the
  // seeded field signals above, which only need to be right on mount).
  //
  // openedAt > 0 distinguishes a real reopen (onOpen increments openCount
  // synchronously before the dialog shows) from the initial mount, which
  // happens immediately on Settings page load while every row's Edit dialog
  // is still closed — auto-fetching there would silently connect to every
  // configured server just from opening the page, which is exactly the
  // "no auto-connect on page load" behavior this drawer must not reintroduce.
  // Only a genuine open of a specific Edit drawer (a deliberate, targeted
  // action) auto-probes; Add mode never does, since nothing is saved yet.
  const openedAt = openCount.value;
  useEffect(() => {
    capabilities.value = { status: 'idle' };
    saveError.value = null;
    if (openedAt > 0 && mode === 'edit' && initial) {
      void handleTest();
    }
  }, [openedAt]);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    isSaving.value = true;
    saveError.value = null;
    try {
      await onSave(name.value.trim(), buildConfig());
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      isSaving.value = false;
    }
  }

  return (
    <form onSubmit={handleSubmit} class="flex min-h-full flex-col">
      <div class="flex-1 space-y-4 overflow-y-auto p-4">
        <div class="space-y-1.5">
          <Label htmlFor={`mcp-server-name-${instanceKey}`}>Name</Label>
          <Input
            id={`mcp-server-name-${instanceKey}`}
            value={name.value}
            onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
            disabled={mode === 'edit'}
            required
          />
        </div>

        <div class="space-y-1.5">
          <Label htmlFor={`mcp-server-transport-${instanceKey}`}>Transport</Label>
          <Select value={transport.value} onValueChange={(v) => (transport.value = v as Transport)}>
            <SelectTrigger id={`mcp-server-transport-${instanceKey}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex items-center gap-2">
          <Switch checked={enabled.value} onCheckedChange={(v) => (enabled.value = v)} />
          <Label>Enabled</Label>
        </div>

        {transport.value === 'stdio' ? (
          <>
            <div class="space-y-1.5">
              <Label htmlFor={`mcp-server-command-${instanceKey}`}>Command</Label>
              <Input
                id={`mcp-server-command-${instanceKey}`}
                value={command.value}
                onInput={(e) => (command.value = (e.target as HTMLInputElement).value)}
                required
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor={`mcp-server-args-${instanceKey}`}>Arguments (one per line)</Label>
              <Textarea
                id={`mcp-server-args-${instanceKey}`}
                rows={3}
                value={args.value}
                onInput={(e) => (args.value = (e.target as HTMLTextAreaElement).value)}
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor={`mcp-server-cwd-${instanceKey}`}>Working directory</Label>
              <Input
                id={`mcp-server-cwd-${instanceKey}`}
                value={cwd.value}
                onInput={(e) => (cwd.value = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="space-y-1.5">
              <Label>Environment variables</Label>
              <KeyValueList
                key={openedAt}
                value={env.value}
                onChange={(next) => (env.value = next)}
                keyPlaceholder="NAME"
                valuePlaceholder="value"
                addLabel="Add env var"
              />
            </div>
            <div class="flex items-center gap-2">
              <Switch
                checked={restartEnabled.value}
                onCheckedChange={(v) => (restartEnabled.value = v)}
              />
              <Label>Restart on failure</Label>
            </div>
          </>
        ) : (
          <>
            <div class="space-y-1.5">
              <Label htmlFor={`mcp-server-url-${instanceKey}`}>URL</Label>
              <Input
                id={`mcp-server-url-${instanceKey}`}
                value={url.value}
                onInput={(e) => (url.value = (e.target as HTMLInputElement).value)}
                placeholder="https://example.com/mcp"
                required
              />
            </div>
            <div class="space-y-1.5">
              <Label>Headers</Label>
              <KeyValueList
                key={openedAt}
                value={headers.value}
                onChange={(next) => (headers.value = next)}
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
                addLabel="Add header"
              />
            </div>
            <div class="flex items-center gap-2">
              <Switch
                checked={reconnectEnabled.value}
                onCheckedChange={(v) => (reconnectEnabled.value = v)}
              />
              <Label>Reconnect on failure</Label>
            </div>
          </>
        )}

        <div class="space-y-2 rounded-md border border-border p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleTest()}
            disabled={capabilities.value.status === 'loading'}
          >
            {capabilities.value.status === 'loading' && <Loader2 class="size-3.5 animate-spin" />}
            Test connection
          </Button>
          <McpCapabilitiesPanel state={capabilities.value} />
        </div>

        {saveError.value && <p class="text-xs text-destructive">{saveError.value}</p>}
      </div>

      <div class="flex justify-end gap-2 border-t border-border p-3">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSaving.value}>
          {isSaving.value && <Loader2 class="size-3.5 animate-spin" />}
          {mode === 'add' ? 'Add server' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
