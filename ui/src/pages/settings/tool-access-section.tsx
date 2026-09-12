import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Loader2 } from 'lucide-preact';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { showToast } from '@/lib/toast';
import {
  fetchToolSettings,
  patchToolSetting,
  refreshToolSettings,
  type ToolSettingItem,
} from '@/services/tool-settings-api';
import { fetchAllSkills } from '@/services/skills-manage-api';
import { GATED_SKILL_NAMES, GATED_TOOL_BY_SKILL } from './skill-gated-names';

// Inverse of GATED_TOOL_BY_SKILL (skillCommand -> toolId) — ToolSettingItem
// has no skillCommand field of its own (that's catalog-only, backend-side),
// so this is how a skill-gated row finds its backing skill's enabled state.
const SKILL_COMMAND_BY_TOOL_ID: Record<string, string> = Object.fromEntries(
  Object.entries(GATED_TOOL_BY_SKILL).map(([command, toolId]) => [toolId, command]),
);

// Master tool list for the "Tool Access" section (issue #171) — global
// enable/default-include control, grouped by category. Kept as its own
// component/fetch (not routed through useSettingsSection's batched
// save-bar form) since every toggle here fires immediately, mirroring
// mcp-servers-panel.tsx's optimistic per-row pattern rather than the rest
// of this page's Save/Discard form.
//
// design: docs/superpowers/specs/2026-09-12-tool-management-ui-design.md §7

function statusLabel(tool: ToolSettingItem): string {
  if (tool.category !== 'mcp') return '';
  if (tool.lastStatus === 'connected') return 'Connected';
  if (tool.lastStatus === 'unreachable') return 'Unreachable';
  return 'Not checked yet';
}

function statusDotClass(tool: ToolSettingItem): string {
  if (tool.lastStatus === 'connected') return 'bg-green-500';
  if (tool.lastStatus === 'unreachable') return 'bg-destructive';
  return 'bg-muted-foreground/40';
}

interface ToolRowProps {
  tool: ToolSettingItem;
  onToggleEnabled?: (tool: ToolSettingItem, next: boolean) => void;
  onToggleDefault?: (tool: ToolSettingItem, next: boolean) => void;
  readOnlyNote?: string;
}

function ToolRow({ tool, onToggleEnabled, onToggleDefault, readOnlyNote }: ToolRowProps) {
  return (
    <li data-slot="tool-settings-row" class="flex flex-col gap-2 py-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 flex-col">
          <div class="flex items-center gap-2">
            <span data-slot="tool-settings-row-name" class="text-sm font-medium">
              {tool.name}
            </span>
            {tool.category === 'mcp' && (
              <span
                data-slot="tool-settings-row-status"
                class="flex items-center gap-1 text-xs text-muted-foreground"
              >
                <span class={`size-1.5 rounded-full ${statusDotClass(tool)}`} />
                {statusLabel(tool)}
              </span>
            )}
          </div>
          <span class="text-xs text-muted-foreground">{tool.description}</span>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          {readOnlyNote ? (
            <span class="text-xs text-muted-foreground">{readOnlyNote}</span>
          ) : (
            <>
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={tool.defaultInclude}
                  disabled={!tool.enabled}
                  onChange={(e) =>
                    onToggleDefault?.(tool, (e.target as HTMLInputElement).checked)
                  }
                />
                Default
              </label>
              <Switch
                checked={tool.enabled}
                onCheckedChange={(v) => onToggleEnabled?.(tool, v)}
                aria-label={`Enable ${tool.name}`}
              />
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export function ToolAccessSection() {
  const tools = useSignal<ToolSettingItem[]>([]);
  const loading = useSignal(true);
  const loadError = useSignal<string | null>(null);
  const refreshing = useSignal(false);
  const skillEnabledByCommand = useSignal<Record<string, boolean>>({});

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

    // Best-effort: cross-reference skill-gated rows against the Skills
    // panel's own enabled state, purely for display. If this fails for any
    // reason, skill-gated rows just show without a skill-status note —
    // never blocks the rest of the section from loading.
    fetchAllSkills()
      .then((skills) => {
        const byCommand: Record<string, boolean> = {};
        for (const skill of skills) {
          const command = skill.slashCommand.replace(/^\//, '');
          if (GATED_SKILL_NAMES.includes(command)) byCommand[command] = skill.enabled;
        }
        skillEnabledByCommand.value = byCommand;
      })
      .catch(() => {});
  }, []);

  async function handleToggleEnabled(tool: ToolSettingItem, next: boolean) {
    try {
      await patchToolSetting(tool.toolId, { enabled: next });
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to update tool');
    }
  }

  async function handleToggleDefault(tool: ToolSettingItem, next: boolean) {
    try {
      await patchToolSetting(tool.toolId, { defaultInclude: next });
      await load();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to update tool');
    }
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

  const builtIn = tools.value.filter((t) => t.category === 'built-in');
  const wiki = tools.value.filter((t) => t.category === 'wiki');
  const skillGated = tools.value.filter((t) => t.category === 'skill-gated');
  const mcpByServer = new Map<string, ToolSettingItem[]>();
  for (const tool of tools.value.filter((t) => t.category === 'mcp')) {
    const key = tool.mcpServer ?? 'unknown';
    mcpByServer.set(key, [...(mcpByServer.get(key) ?? []), tool]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool Access</CardTitle>
      </CardHeader>
      <CardContent class="space-y-6">
        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Built-in</h3>
          <ul class="divide-y divide-border">
            {builtIn.map((tool) => (
              <ToolRow
                key={tool.toolId}
                tool={tool}
                onToggleEnabled={handleToggleEnabled}
                onToggleDefault={handleToggleDefault}
              />
            ))}
          </ul>
        </div>

        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Wiki (always available)</h3>
          <ul class="divide-y divide-border">
            {wiki.map((tool) => (
              <ToolRow key={tool.toolId} tool={tool} readOnlyNote="Always on" />
            ))}
          </ul>
        </div>

        <div>
          <h3 class="mb-1 text-sm font-medium text-muted-foreground">Skill-gated</h3>
          <ul class="divide-y divide-border">
            {skillGated.map((tool) => {
              const command = SKILL_COMMAND_BY_TOOL_ID[tool.toolId];
              const enabled = command ? skillEnabledByCommand.value[command] : undefined;
              return (
                <ToolRow
                  key={tool.toolId}
                  tool={tool}
                  readOnlyNote={
                    enabled === undefined
                      ? 'Gated by skill'
                      : enabled
                        ? 'Skill: enabled'
                        : 'Skill: disabled'
                  }
                />
              );
            })}
          </ul>
        </div>

        <div>
          <div class="mb-1 flex items-center justify-between">
            <h3 class="text-sm font-medium text-muted-foreground">MCP</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => void handleRefresh()} disabled={refreshing.value}>
              {refreshing.value && <Loader2 class="size-3.5 animate-spin" />}
              Refresh
            </Button>
          </div>
          {mcpByServer.size === 0 ? (
            <p class="py-2 text-sm text-muted-foreground">No MCP tools discovered yet.</p>
          ) : (
            [...mcpByServer.entries()].map(([serverName, serverTools]) => (
              <div key={serverName} class="mb-3">
                <p class="mb-1 text-xs font-medium text-muted-foreground">{serverName}</p>
                <ul class="divide-y divide-border">
                  {serverTools.map((tool) => (
                    <ToolRow
                      key={tool.toolId}
                      tool={tool}
                      onToggleEnabled={handleToggleEnabled}
                      onToggleDefault={handleToggleDefault}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
