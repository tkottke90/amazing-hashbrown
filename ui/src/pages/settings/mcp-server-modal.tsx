import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
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
} from '@/services/mcp-servers-api';
import type { JSX } from 'preact';

type Transport = 'stdio' | 'http' | 'sse';

interface McpServerModalProps {
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

export function McpServerModal({ mode, initial, onSave, trigger }: McpServerModalProps) {
  // Re-open counter, same reason as provider-modal.tsx: dialog children stay
  // mounted between opens, so form state needs an explicit reset hook.
  const openCount = useSignal(0);

  return (
    <Modal
      title={mode === 'add' ? 'Add MCP server' : 'Edit MCP server'}
      className="mx-auto my-16 max-w-lg p-4"
      trigger={trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <McpServerForm mode={mode} initial={initial} onSave={onSave} openCount={openCount} />
    </Modal>
  );
}

interface McpServerFormProps {
  mode: 'add' | 'edit';
  initial?: McpServer;
  onSave: (name: string, config: McpServerConfig) => Promise<void>;
  openCount: Signal<number>;
}

type TestState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'success'; toolCount: number }
  | { status: 'error'; message: string };

function McpServerForm({ mode, initial, onSave, openCount }: McpServerFormProps) {
  const { close } = useDialog();

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

  const testState = useSignal<TestState>({ status: 'idle' });
  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  // Fires once at mount and again each time the dialog is reopened, mirroring
  // provider-modal.tsx's ProviderForm — resets transient UI state (not the
  // seeded field signals above, which only need to be right on mount).
  const openedAt = openCount.value;
  useEffect(() => {
    testState.value = { status: 'idle' };
    saveError.value = null;
  }, [openedAt]);

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
    testState.value = { status: 'checking' };
    try {
      const config = buildConfig();
      const result =
        mode === 'add'
          ? await testNewMcpServer(config)
          : await testExistingMcpServer(initial!.name, config);
      testState.value = { status: 'success', toolCount: result.toolCount };
    } catch (err) {
      testState.value = {
        status: 'error',
        message: err instanceof Error ? err.message : 'Test failed',
      };
    }
  }

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
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      <div class="space-y-1.5">
        <Label htmlFor="mcp-server-name">Name</Label>
        <Input
          id="mcp-server-name"
          value={name.value}
          onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
          disabled={mode === 'edit'}
          required
        />
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="mcp-server-transport">Transport</Label>
        <Select value={transport.value} onValueChange={(v) => (transport.value = v as Transport)}>
          <SelectTrigger id="mcp-server-transport">
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
            <Label htmlFor="mcp-server-command">Command</Label>
            <Input
              id="mcp-server-command"
              value={command.value}
              onInput={(e) => (command.value = (e.target as HTMLInputElement).value)}
              required
            />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="mcp-server-args">Arguments (one per line)</Label>
            <Textarea
              id="mcp-server-args"
              rows={3}
              value={args.value}
              onInput={(e) => (args.value = (e.target as HTMLTextAreaElement).value)}
            />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="mcp-server-cwd">Working directory</Label>
            <Input
              id="mcp-server-cwd"
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
            <Label htmlFor="mcp-server-url">URL</Label>
            <Input
              id="mcp-server-url"
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

      <div class="space-y-1.5 rounded-md border border-border p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleTest()}
          disabled={testState.value.status === 'checking'}
        >
          {testState.value.status === 'checking' && <Loader2 class="size-3.5 animate-spin" />}
          Test connection
        </Button>
        {testState.value.status === 'success' && (
          <p class="text-xs text-primary">
            {`Connected — found ${testState.value.toolCount} tool${
              testState.value.toolCount === 1 ? '' : 's'
            }.`}
          </p>
        )}
        {testState.value.status === 'error' && (
          <p class="text-xs text-destructive">{testState.value.message}</p>
        )}
      </div>

      {saveError.value && <p class="text-xs text-destructive">{saveError.value}</p>}

      <div class="flex justify-end gap-2">
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
