import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Drawer } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import {
  threadToolsDrawerOpen,
  threadToolsData,
  threadToolsLoading,
  threadToolsSaving,
  closeThreadToolsDrawer,
  saveThreadTools,
  resetThreadToolsToDefaults,
} from '@/hooks/use-thread-tools';
import type { ThreadToolItem, ThreadToolsResponse } from '@/services/tool-settings-api';

// Per-thread "Edit Tools" drawer, opened from the chat window's `+` menu
// (chat-input.tsx). Same grouped layout as the Settings > Tools page's
// ToolAccessSection, scoped to one thread.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §8

function ThreadToolRow({
  tool,
  checked,
  onToggle,
}: {
  tool: ThreadToolItem;
  checked: boolean;
  onToggle?: (next: boolean) => void;
}) {
  const readOnly = tool.category === 'wiki' || tool.category === 'skill-gated' || !onToggle;
  const disabledGlobally = !tool.enabled;

  return (
    <li data-slot="thread-tool-row" class="flex items-center justify-between gap-3 py-2">
      <div class="flex min-w-0 flex-col">
        <span class="text-sm font-medium">{tool.name}</span>
        <span class="text-xs text-muted-foreground">{tool.description}</span>
      </div>
      {readOnly ? (
        <span class="shrink-0 text-xs text-muted-foreground">
          {tool.category === 'wiki' ? 'Always on' : 'Gated by skill'}
        </span>
      ) : (
        <label
          class="flex shrink-0 items-center gap-1.5 text-xs"
          title={disabledGlobally ? 'Disabled globally — enable in Settings > Tools' : undefined}
        >
          <input
            type="checkbox"
            checked={checked}
            disabled={disabledGlobally}
            aria-label={`Include ${tool.name}`}
            onChange={(e) => onToggle?.((e.target as HTMLInputElement).checked)}
          />
          {disabledGlobally && <span class="text-muted-foreground">disabled globally</span>}
        </label>
      )}
    </li>
  );
}

function ThreadToolsBody() {
  const checkedIds = useSignal<Set<string>>(new Set());
  // Tracks which threadToolsData object checkedIds was last derived from —
  // NOT a useEffect: an effect's callback is deferred to after commit (a
  // later tick/animation frame in Preact's hooks scheduler), which leaves a
  // real window where a checkbox click can land between "data rendered" and
  // "effect actually ran", and the effect then overwrites the click's
  // result when it finally fires. Deriving synchronously during render, on
  // the same tick the new data object shows up, closes that window
  // entirely. Guarded by object-identity so this doesn't re-derive (and
  // wipe in-progress edits) on every render — only when threadToolsData
  // actually changes to a new object (a fresh load, save, or reset).
  const syncedFor = useSignal<ThreadToolsResponse | null>(null);
  if (threadToolsData.value && syncedFor.value !== threadToolsData.value) {
    checkedIds.value = new Set(
      threadToolsData.value.tools
        .filter((t) => t.category === 'built-in' || t.category === 'mcp')
        .filter((t) => t.selected)
        .map((t) => t.toolId),
    );
    syncedFor.value = threadToolsData.value;
  }

  if (threadToolsLoading.value || !threadToolsData.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const tools = threadToolsData.value.tools;
  const builtIn = tools.filter((t) => t.category === 'built-in');
  const wiki = tools.filter((t) => t.category === 'wiki');
  const skillGated = tools.filter((t) => t.category === 'skill-gated');
  const mcp = tools.filter((t) => t.category === 'mcp');

  function toggle(toolId: string, next: boolean) {
    const updated = new Set(checkedIds.value);
    if (next) updated.add(toolId);
    else updated.delete(toolId);
    checkedIds.value = updated;
  }

  async function handleSave() {
    await saveThreadTools([...checkedIds.value]);
  }

  async function handleReset() {
    await resetThreadToolsToDefaults();
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex-1 space-y-6 overflow-y-auto p-6">
        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Built-in</h3>
          <ul class="divide-y divide-border">
            {builtIn.map((tool) => (
              <ThreadToolRow
                key={tool.toolId}
                tool={tool}
                checked={checkedIds.value.has(tool.toolId)}
                onToggle={(next) => toggle(tool.toolId, next)}
              />
            ))}
          </ul>
        </div>

        {mcp.length > 0 && (
          <div>
            <h3 class="mb-1 text-sm font-medium text-muted-foreground">MCP</h3>
            <ul class="divide-y divide-border">
              {mcp.map((tool) => (
                <ThreadToolRow
                  key={tool.toolId}
                  tool={tool}
                  checked={checkedIds.value.has(tool.toolId)}
                  onToggle={(next) => toggle(tool.toolId, next)}
                />
              ))}
            </ul>
          </div>
        )}

        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Wiki</h3>
          <ul class="divide-y divide-border">
            {wiki.map((tool) => (
              <ThreadToolRow key={tool.toolId} tool={tool} checked />
            ))}
          </ul>
        </div>

        {skillGated.length > 0 && (
          <div>
            <h3 class="mb-1 text-sm font-medium text-muted-foreground">Skill-gated</h3>
            <ul class="divide-y divide-border">
              {skillGated.map((tool) => (
                <ThreadToolRow key={tool.toolId} tool={tool} checked={false} />
              ))}
            </ul>
          </div>
        )}
      </div>

      <div class="flex items-center justify-between gap-2 border-t border-border p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleReset()}
          disabled={threadToolsSaving.value}
        >
          Reset to defaults
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={threadToolsSaving.value}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export function ThreadToolsDrawer() {
  // Same close-path sync as skill-drawer.tsx: the X button and Escape close
  // the dialog natively without going through closeThreadToolsDrawer().
  useEffect(() => {
    if (!threadToolsDrawerOpen.value) closeThreadToolsDrawer();
  }, [threadToolsDrawerOpen.value]);

  return (
    <Drawer
      open={threadToolsDrawerOpen}
      title="Edit Tools"
      className="w-[90vw]! rounded-none! border-0! bg-background! p-0! border-l border-border sm:w-[420px]! sm:max-w-[90vw]!"
    >
      <ThreadToolsBody />
    </Drawer>
  );
}
