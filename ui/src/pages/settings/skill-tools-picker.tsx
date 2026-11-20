import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Checkbox } from '@/components/ui/checkbox';
import { ClearableInput } from '@/components/ui/input';
import { fetchToolSettings, type ToolSettingItem } from '@/services/tool-settings-api';
import { cn } from '@/lib/utils';

// Backs the "Tools this skill has access to" field in SkillDetailsTab —
// the real picker the shelved `allowedTools` field in skill-details-tab.tsx
// was waiting on (issue #409). Reuses the same reconciled-catalog endpoint
// the Tool Settings page (tool-access-table.tsx) already calls — no new
// backend endpoint needed — but groups by source (Built-in, then each MCP
// server) rather than that page's deliberately flat layout: an author
// thinks "this skill needs the n8n tools," not an alphabetical soup.
//
// `value`/`onChange` carry the raw comma-separated string
// (SkillFrontmatter.tools's own shape) — this component never owns that
// state itself, it's a controlled picker over it, same pattern as a plain
// <input>.
export function SkillToolsPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const catalog = useSignal<ToolSettingItem[]>([]);
  const loading = useSignal(true);
  const loadError = useSignal<string | null>(null);
  const search = useSignal('');

  useEffect(() => {
    fetchToolSettings()
      .then((items) => {
        catalog.value = items;
      })
      .catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : 'Failed to load tool catalog';
      })
      .finally(() => {
        loading.value = false;
      });
  }, []);

  // `value` is a plain prop, not a signal — computed directly in the render
  // body rather than via useComputed(), which only tracks signals and would
  // otherwise freeze on the prop's first-render value (ui/AGENTS.md).
  const selectedIds = new Set(
    value
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  function setChecked(toolId: string, checked: boolean) {
    const next = new Set(selectedIds);
    if (checked) next.add(toolId);
    else next.delete(toolId);
    onChange([...next].join(','));
  }

  // A selected id the live catalog doesn't recognize (typo, a removed tool,
  // an MCP server no longer configured) — shown so the author can see and
  // remove it, distinct from the server-side silent drop at gating-
  // reconciliation time, which never touches what's actually written in
  // frontmatter.
  const unknownIds = [...selectedIds].filter((id) => !catalog.value.some((t) => t.toolId === id));

  const query = search.value.trim().toLowerCase();
  const filtered = catalog.value.filter(
    (tool) =>
      !query ||
      tool.name.toLowerCase().includes(query) ||
      tool.description.toLowerCase().includes(query),
  );

  const groups = new Map<string, ToolSettingItem[]>();
  for (const tool of filtered) {
    const groupName = tool.category === 'mcp' ? (tool.mcpServer ?? 'MCP') : 'Built-in';
    const list = groups.get(groupName) ?? [];
    list.push(tool);
    groups.set(groupName, list);
  }
  const groupNames = [...groups.keys()].sort((a, b) => {
    if (a === 'Built-in') return -1;
    if (b === 'Built-in') return 1;
    return a.localeCompare(b);
  });

  if (loadError.value) {
    return <p class="text-sm text-destructive">{loadError.value}</p>;
  }

  if (loading.value) {
    return <p class="text-sm text-muted-foreground">Loading tools…</p>;
  }

  return (
    <div class="space-y-2">
      {unknownIds.length > 0 && (
        <div class="flex flex-wrap gap-1.5">
          {unknownIds.map((id) => (
            <span
              key={id}
              title="This tool id isn't in the current catalog — it may have been removed or renamed."
              class="rounded border border-destructive/50 bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
            >
              Unknown tool: {id}
            </span>
          ))}
        </div>
      )}
      <ClearableInput
        value={search.value}
        onInput={(e) => (search.value = (e.target as HTMLInputElement).value)}
        placeholder="Search tools"
        aria-label="Search tools"
      />
      <div class="max-h-72 overflow-y-auto rounded-md border border-border">
        {groupNames.length === 0 && (
          <p class="px-3 py-4 text-center text-sm text-muted-foreground">
            No tools match your search.
          </p>
        )}
        {groupNames.map((groupName) => (
          <div key={groupName}>
            <div class="border-b border-border bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {groupName}
            </div>
            {groups.get(groupName)!.map((tool) => (
              <label
                key={tool.toolId}
                class={cn(
                  'flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted/50',
                  tool.enabled ? '' : 'opacity-40',
                )}
              >
                <Checkbox
                  checked={selectedIds.has(tool.toolId)}
                  onCheckedChange={(checked) => setChecked(tool.toolId, checked === true)}
                />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-sm font-medium">{tool.name}</span>
                    {!tool.enabled && (
                      <span class="shrink-0 text-xs text-muted-foreground">
                        (disabled — won't take effect)
                      </span>
                    )}
                  </span>
                  <span class="line-clamp-1 text-xs text-muted-foreground">{tool.description}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
