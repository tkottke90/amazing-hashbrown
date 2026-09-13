import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Drawer } from '@tkottke90/preact-dialog';
import { Loader2 } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { ClearableInput } from '@/components/ui/input';
import {
  threadToolsDrawerOpen,
  threadToolsData,
  threadToolsLoading,
  threadToolsSaving,
  closeThreadToolsDrawer,
  saveThreadTools,
} from '@/hooks/use-thread-tools';
import type { ThreadToolItem, ThreadToolsResponse } from '@/services/tool-settings-api';

// Per-thread "Edit Tools" drawer, opened from the chat window's `+` menu
// (chat-input.tsx). Assignment-based layout (Built-in / Assigned /
// Available), scoped to one thread — reads the same underlying per-tool
// data as Settings > Tools' table+drawer (tool-access-table.tsx) through a
// different endpoint (/threads/:id/tools), but presents it differently:
// this drawer answers "what does this thread have access to right now?",
// not "what tools exist system-wide?".
//
// design: docs/superpowers/specs/2026-09-13-edit-tools-drawer-assignment-redesign-design.md

// Single source of truth for Built-in-section membership — reused by the
// seed logic and both non-Built-in section filters below, so the "not
// Built-in" condition can't drift between call sites.
function isBuiltInTool(tool: ThreadToolItem): boolean {
  return tool.alwaysOn || tool.category === 'skill-gated';
}

// A small local derivation, not tool-access-table.tsx's sourceLabel() —
// that one returns a bare 'MCP' with no server name; this drawer wants the
// combined `MCP: <server>` form (matching the reference screenshot this
// redesign is based on), and importing across the pages/settings/
// boundary for one string isn't worth the coupling.
function originBadge(tool: ThreadToolItem): string {
  return tool.category === 'mcp' ? `MCP: ${tool.mcpServer}` : 'Built-in';
}

type ToolRowAction =
  | { kind: 'none'; caption: string }
  | { kind: 'remove'; onRemove: () => void }
  | { kind: 'add'; onAdd: () => void };

function ToolRow({ tool, action }: { tool: ThreadToolItem; action: ToolRowAction }) {
  return (
    <li data-slot="thread-tool-row" class="flex items-center justify-between gap-3 py-2">
      <div class="flex min-w-0 flex-col">
        <div class="flex items-center gap-1.5">
          <span class="text-sm font-medium">{tool.name}</span>
          <span
            data-slot="thread-tool-row-badge"
            class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
          >
            {originBadge(tool)}
          </span>
        </div>
        <span class="text-xs text-muted-foreground">{tool.description}</span>
      </div>
      {action.kind === 'none' && (
        <span class="shrink-0 text-xs text-muted-foreground">{action.caption}</span>
      )}
      {action.kind === 'remove' && (
        <Button type="button" variant="link" size="sm" onClick={action.onRemove}>
          Remove
        </Button>
      )}
      {action.kind === 'add' && (
        <Button type="button" variant="link" size="sm" onClick={action.onAdd}>
          + Add
        </Button>
      )}
    </li>
  );
}

function ThreadToolsBody() {
  const assignedIds = useSignal<Set<string>>(new Set());
  // Tracks which threadToolsData object assignedIds was last derived from —
  // NOT a useEffect: an effect's callback is deferred to after commit (a
  // later tick/animation frame in Preact's hooks scheduler), which leaves a
  // real window where an Add/Remove click can land between "data rendered"
  // and "effect actually ran", and the effect then overwrites the click's
  // result when it finally fires. Deriving synchronously during render, on
  // the same tick the new data object shows up, closes that window
  // entirely. Guarded by object-identity so this doesn't re-derive (and
  // wipe in-progress edits) on every render — only when threadToolsData
  // actually changes to a new object (a fresh load or a successful save).
  const syncedFor = useSignal<ThreadToolsResponse | null>(null);
  // The Drawer keeps this component mounted between opens (same as every
  // other drawer in this codebase — see tool-settings-drawer.tsx's own
  // comment on the same pattern), so this signal would otherwise leak a
  // typed-in query from one open into the next. Reset it in the same
  // identity-guarded block as assignedIds, for the same "new data object"
  // trigger (a fresh open, or a completed save).
  const search = useSignal('');
  if (threadToolsData.value && syncedFor.value !== threadToolsData.value) {
    assignedIds.value = new Set(
      threadToolsData.value.tools
        .filter((t) => !isBuiltInTool(t) && t.selected)
        .map((t) => t.toolId),
    );
    search.value = '';
    syncedFor.value = threadToolsData.value;
  }

  if (threadToolsLoading.value || !threadToolsData.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const tools = threadToolsData.value.tools;
  const builtIn = tools.filter(isBuiltInTool);
  const nonBuiltIn = tools.filter((t) => !isBuiltInTool(t));
  // Assigned/Available membership tracks the LIVE local set, not the
  // snapshot's `selected` flag, so Add/Remove move a row between sections
  // immediately without a save round-trip.
  const assigned = nonBuiltIn.filter((t) => assignedIds.value.has(t.toolId));
  const available = nonBuiltIn.filter((t) => !assignedIds.value.has(t.toolId) && t.enabled);

  const query = search.value.trim().toLowerCase();
  const filteredAvailable = query
    ? available.filter(
        (t) => t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
      )
    : available;

  function addTool(toolId: string) {
    const next = new Set(assignedIds.value);
    next.add(toolId);
    assignedIds.value = next;
  }

  function removeTool(toolId: string) {
    const next = new Set(assignedIds.value);
    next.delete(toolId);
    assignedIds.value = next;
  }

  async function handleSave() {
    await saveThreadTools([...assignedIds.value]);
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex-1 space-y-6 overflow-y-auto p-6">
        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Built-in</h3>
          <ul class="divide-y divide-border">
            {builtIn.map((tool) => (
              <ToolRow
                key={tool.toolId}
                tool={tool}
                action={{ kind: 'none', caption: tool.alwaysOn ? 'Always on' : 'Gated by skill' }}
              />
            ))}
          </ul>
        </div>

        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Assigned</h3>
          {assigned.length === 0 ? (
            <p class="py-2 text-xs text-muted-foreground">No tools assigned yet</p>
          ) : (
            <ul class="divide-y divide-border">
              {assigned.map((tool) => (
                <ToolRow
                  key={tool.toolId}
                  tool={tool}
                  action={{ kind: 'remove', onRemove: () => removeTool(tool.toolId) }}
                />
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Available</h3>
          <ClearableInput
            value={search.value}
            onInput={(e) => (search.value = (e.target as HTMLInputElement).value)}
            placeholder="Search tools"
            aria-label="Search available tools"
            className="mb-2 max-w-[60ch]"
          />
          {filteredAvailable.length === 0 ? (
            query.length > 0 && <p class="py-2 text-xs text-muted-foreground">No matching tools</p>
          ) : (
            <ul class="divide-y divide-border">
              {filteredAvailable.map((tool) => (
                <ToolRow
                  key={tool.toolId}
                  tool={tool}
                  action={{ kind: 'add', onAdd: () => addTool(tool.toolId) }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div class="flex justify-end gap-2 border-t border-border p-4">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={threadToolsSaving.value}
        >
          {threadToolsSaving.value && <Loader2 class="size-3.5 animate-spin" />}
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
      className="w-[90vw]! rounded-none! border-0! bg-background! p-0! border-l border-border sm:max-w-5xl"
    >
      <ThreadToolsBody />
    </Drawer>
  );
}
