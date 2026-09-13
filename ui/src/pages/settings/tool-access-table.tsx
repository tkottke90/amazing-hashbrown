import { useEffect } from 'preact/hooks';
import { useComputed, useSignal } from '@preact/signals';
import { Loader2, RefreshCcw } from 'lucide-preact';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ClearableInput, Input } from '@/components/ui/input';
import { showToast } from '@/lib/toast';
import { ToolSettingsDrawer } from '@/components/tool-settings-drawer';
import {
  fetchToolSettings,
  refreshToolSettings,
  type ToolSettingItem,
} from '@/services/tool-settings-api';
import { cn } from '@/lib/utils';

// Replaces the old category-grouped ToolAccessSection with a single
// alphabetical, searchable table — grouping by type made a tool hard to
// find without already knowing what kind it was. Also folds in the config
// previously split across separate Web Fetch/RLM/Shell cards on this same
// page — each tool's full configuration now lives in its own drawer.
//
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §1/§2

function sourceLabel(tool: ToolSettingItem): string {
  switch (tool.category) {
    case 'mcp':
      return 'MCP';
    case 'built-in':
    case 'wiki':
    case 'skill-gated':
    default:
      return 'Built-in';
  }
}

function statusDotClass(tool: ToolSettingItem): string {
  if (tool.category !== 'mcp') return '';
  if (tool.lastStatus === 'connected') return 'bg-green-500';
  if (tool.lastStatus === 'unreachable') return 'bg-destructive';
  return 'bg-muted-foreground/40';
}

interface ToolRowProps {
  tool: ToolSettingItem;
  onSaved: (updated: ToolSettingItem) => void;
}

function ToolRow({ tool, onSaved }: ToolRowProps) {
  return (
    <ToolSettingsDrawer
      tool={tool}
      onSaved={onSaved}
      trigger={
        <button
          type="button"
          data-slot="tool-access-row"
          className={
            cn(
              "grid w-full grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 border-b border-border px-3 py-2.5 text-left hover:bg-muted/50",
              tool.enabled ? '' : 'opacity-40'
            )
          }
        >
          <span class="flex min-w-0 items-center gap-1.5">
            {tool.category === 'mcp' && (
              <span class={`size-1.5 shrink-0 rounded-full ${statusDotClass(tool)}`} />
            )}
            <span data-slot="tool-access-row-name" class="truncate text-sm font-medium">
              {tool.name}
            </span>
            {!tool.enabled && (
              <span class="shrink-0 text-xs text-muted-foreground">(disabled)</span>
            )}
          </span>
          <span class="line-clamp-2 text-xs text-muted-foreground">{tool.description}</span>
          <span
            data-slot="tool-access-row-source"
            class="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {sourceLabel(tool)}
          </span>
        </button>
      }
    />
  );
}

export function ToolAccessTable() {
  const tools = useSignal<ToolSettingItem[]>([]);
  const loading = useSignal(true);
  const loadError = useSignal<string | null>(null);
  const refreshing = useSignal(false);
  const search = useSignal('');

  async function load() {
    tools.value = await fetchToolSettings();
  }

  useEffect(() => {
    load()
      .catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : 'Failed to load tool settings';
      })
      .finally(() => {
        loading.value = false;
      });
  }, []);

  function handleSaved(updated: ToolSettingItem) {
    tools.value = tools.value.map((t) => (t.toolId === updated.toolId ? updated : t));
  }

  async function handleRefresh() {
    refreshing.value = true;
    try {
      tools.value = await refreshToolSettings();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to refresh MCP tools');
    } finally {
      refreshing.value = false;
    }
  }

  const filtered = useComputed(() => {
    const query = search.value.trim().toLowerCase();
    const sorted = [...tools.value].sort((a, b) => a.name.localeCompare(b.name));
    if (!query) return sorted;
    return sorted.filter(
      (t) => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
    );
  });

  if (loadError.value) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tool Access</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm text-destructive">{loadError.value}</p>
        </CardContent>
      </Card>
    );
  }

  if (loading.value) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tool Access</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader class="flex flex-row items-center justify-between gap-3">
        <CardTitle className="flex justify-between">
          <span>Tool Access ({tools.value.length})</span>
          <span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title="Refresh List"
              onClick={() => void handleRefresh()}
              disabled={refreshing.value}
            >
              {refreshing.value && <Loader2 class="size-3.5 animate-spin" />}
              {!refreshing.value && <RefreshCcw class="size-3.5" />}
              Refresh
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent class="space-y-3">
        <ClearableInput
          value={search.value}
          onInput={(e) => (search.value = (e.target as HTMLInputElement).value)}
          placeholder="Search tools"
          aria-label="Search tools"
          className="max-w-[60ch]"
        />
        <br />
        <br />
        {filtered.value.length === 0 ? (
          <p class="py-4 text-center text-sm text-muted-foreground">No tools match your search.</p>
        ) : (
          <div class="rounded-md border border-border">
            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
              <span>Name</span>
              <span>Description</span>
              <span>Source</span>
            </div>
            {filtered.value.map((tool) => (
              <ToolRow key={tool.toolId} tool={tool} onSaved={handleSaved} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
