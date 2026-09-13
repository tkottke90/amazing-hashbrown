import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Loader2 } from 'lucide-preact';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import {
  patchToolSetting,
  resetToolSetting,
  type ToolSettingItem,
  type ToolSettingPatch,
} from '@/services/tool-settings-api';
import type { JSX } from 'preact';

// Per-tool global admin drawer (Settings > Tools) — trigger-driven, same
// convention as mcp-server-drawer.tsx (not the controlled-signal pattern
// thread-tools-drawer.tsx uses, which exists only because that one opens
// from inside a nested dropdown menu several components away; this one
// opens directly from its own table row).
//
// design: docs/superpowers/specs/2026-09-13-tool-settings-redesign-design.md §2/§6

function arrayToLines(arr?: string[]): string {
  return arr?.join('\n') ?? '';
}

function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

interface ToolSettingsDrawerProps {
  tool: ToolSettingItem;
  onSaved: (updated: ToolSettingItem) => void;
  trigger: JSX.Element;
}

export function ToolSettingsDrawer({ tool, onSaved, trigger }: ToolSettingsDrawerProps) {
  // Re-open counter, same reason as mcp-server-drawer.tsx: dialog children
  // stay mounted between opens, so form state needs an explicit reset hook.
  const openCount = useSignal(0);

  return (
    <Drawer
      title={tool.name}
      side="right"
      className="w-[90vw]! sm:w-4xl! sm:max-w-[90vw]!"
      trigger={trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <ToolSettingsForm tool={tool} onSaved={onSaved} openCount={openCount} />
    </Drawer>
  );
}

interface ToolSettingsFormProps {
  tool: ToolSettingItem;
  onSaved: (updated: ToolSettingItem) => void;
  openCount: Signal<number>;
}

function ToolSettingsForm({ tool, onSaved, openCount }: ToolSettingsFormProps) {
  const { close } = useDialog();

  const description = useSignal(tool.description);
  const instructions = useSignal(tool.instructions);
  const enabled = useSignal(tool.enabled);
  const includeChat = useSignal(tool.defaultInclude.chat);
  const includeSubAgent = useSignal(tool.defaultInclude.subAgent);
  const includeAutonomous = useSignal(tool.defaultInclude.autonomous);

  // Tool-specific extra fields — only ever read for their matching toolId.
  const timeoutMs = useSignal(tool.timeoutMs ?? 10000);
  const respectRobotsTxt = useSignal(tool.respectRobotsTxt ?? true);
  const provider = useSignal(tool.provider ?? '');
  const model = useSignal(tool.model ?? '');
  const maxIterations = useSignal(tool.maxIterations ?? 10);
  const truncateThreshold = useSignal(tool.truncateThreshold ?? 6000);
  const allowlist = useSignal(arrayToLines(tool.allowlist));
  const denylist = useSignal(arrayToLines(tool.denylist));

  const isSaving = useSignal(false);
  const isResetting = useSignal(false);
  const saveError = useSignal<string | null>(null);

  const isAlwaysOn = tool.alwaysOn;
  const isSkillGated = tool.category === 'skill-gated';

  // Dialog children stay mounted between opens (see mcp-server-drawer.tsx's
  // identical comment) — reset local form state every time this specific
  // tool's drawer is reopened.
  const openedAt = openCount.value;
  useEffect(() => {
    description.value = tool.description;
    instructions.value = tool.instructions;
    enabled.value = tool.enabled;
    includeChat.value = tool.defaultInclude.chat;
    includeSubAgent.value = tool.defaultInclude.subAgent;
    includeAutonomous.value = tool.defaultInclude.autonomous;
    timeoutMs.value = tool.timeoutMs ?? 10000;
    respectRobotsTxt.value = tool.respectRobotsTxt ?? true;
    provider.value = tool.provider ?? '';
    model.value = tool.model ?? '';
    maxIterations.value = tool.maxIterations ?? 10;
    truncateThreshold.value = tool.truncateThreshold ?? 6000;
    allowlist.value = arrayToLines(tool.allowlist);
    denylist.value = arrayToLines(tool.denylist);
    saveError.value = null;
  }, [openedAt]);

  async function handleSave(e: Event) {
    e.preventDefault();
    isSaving.value = true;
    saveError.value = null;
    try {
      const patch: ToolSettingPatch = {
        description: description.value,
        instructions: instructions.value,
      };
      if (!isAlwaysOn) {
        patch.enabled = enabled.value;
        patch.defaultInclude = {
          chat: includeChat.value,
          subAgent: includeSubAgent.value,
          autonomous: includeAutonomous.value,
        };
      }
      if (tool.toolId === 'web_fetch') {
        patch.timeoutMs = timeoutMs.value;
        patch.respectRobotsTxt = respectRobotsTxt.value;
      } else if (tool.toolId === 'rlm_query') {
        patch.provider = provider.value || undefined;
        patch.model = model.value || undefined;
        patch.maxIterations = maxIterations.value;
        patch.truncateThreshold = truncateThreshold.value;
      } else if (tool.toolId === 'shell_exec') {
        patch.allowlist = linesToArray(allowlist.value);
        patch.denylist = linesToArray(denylist.value);
      }
      const updated = await patchToolSetting(tool.toolId, patch);
      onSaved(updated);
      showToast('success', `${tool.name} updated`);
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      isSaving.value = false;
    }
  }

  async function handleReset() {
    isResetting.value = true;
    saveError.value = null;
    try {
      const updated = await resetToolSetting(tool.toolId);
      onSaved(updated);
      showToast('success', `${tool.name} reset to defaults`);
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to reset';
    } finally {
      isResetting.value = false;
    }
  }

  return (
    <form onSubmit={handleSave} class="flex grow flex-col overflow-hidden">
      <div class="flex-1 space-y-4 overflow-y-auto p-4">
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span
            data-slot="tool-settings-source-badge"
            class="rounded border border-border px-1.5 py-0.5"
          >
            {tool.category === 'mcp' ? 'MCP' : 'Built-in'}
          </span>
          {tool.mcpServer && <span>Server: {tool.mcpServer}</span>}
        </div>

        <div class="space-y-1.5">
          <Label htmlFor="tool-settings-description">Description</Label>
          <Textarea
            id="tool-settings-description"
            rows={3}
            value={description.value}
            disabled={isSkillGated}
            onInput={(e) => (description.value = (e.target as HTMLTextAreaElement).value)}
          />
        </div>

        <div class="space-y-1.5">
          <Label htmlFor="tool-settings-instructions">Instructions</Label>
          <Textarea
            id="tool-settings-instructions"
            rows={4}
            placeholder="Additional guidance injected into the system prompt when this tool is active"
            value={instructions.value}
            disabled={isSkillGated}
            onInput={(e) => (instructions.value = (e.target as HTMLTextAreaElement).value)}
          />
        </div>

        {isSkillGated ? (
          <p class="text-xs text-muted-foreground">
            Gated by a skill — its availability is controlled entirely by that skill, not here.
          </p>
        ) : (
          <>
            <div class="space-y-2">
              <Label>Include by default</Label>
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm">Chat</span>
                <Switch
                  checked={includeChat.value}
                  disabled={isAlwaysOn || !enabled.value}
                  onCheckedChange={(v) => (includeChat.value = v)}
                  aria-label="Include by default in Chat"
                />
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm">Sub-Agent</span>
                <Switch
                  checked={includeSubAgent.value}
                  disabled={isAlwaysOn || !enabled.value}
                  onCheckedChange={(v) => (includeSubAgent.value = v)}
                  aria-label="Include by default in Sub-Agent"
                />
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm">
                  Autonomous <span class="text-xs text-muted-foreground">(coming soon)</span>
                </span>
                <Switch
                  checked={includeAutonomous.value}
                  disabled={isAlwaysOn || !enabled.value}
                  onCheckedChange={(v) => (includeAutonomous.value = v)}
                  aria-label="Include by default in Autonomous"
                />
              </div>
            </div>

            <div class="flex items-center justify-between gap-2">
              <Label>Enabled</Label>
              {isAlwaysOn ? (
                <span class="text-xs text-muted-foreground">Always on</span>
              ) : (
                <Switch
                  checked={enabled.value}
                  onCheckedChange={(v) => (enabled.value = v)}
                  aria-label={`Enable ${tool.name}`}
                />
              )}
            </div>
          </>
        )}

        {tool.toolId === 'web_fetch' && (
          <div class="space-y-3 rounded-md border border-border p-3">
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-timeout">Timeout (ms)</Label>
              <Input
                id="tool-settings-timeout"
                type="number"
                value={String(timeoutMs.value)}
                onInput={(e) => (timeoutMs.value = Number((e.target as HTMLInputElement).value))}
              />
            </div>
            <div class="flex items-center gap-2">
              <Switch
                checked={respectRobotsTxt.value}
                onCheckedChange={(v) => (respectRobotsTxt.value = v)}
              />
              <Label>Respect robots.txt</Label>
            </div>
          </div>
        )}

        {tool.toolId === 'rlm_query' && (
          <div class="space-y-3 rounded-md border border-border p-3">
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-rlm-provider">Provider</Label>
              <Input
                id="tool-settings-rlm-provider"
                value={provider.value}
                placeholder="Default provider"
                onInput={(e) => (provider.value = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-rlm-model">Model</Label>
              <Input
                id="tool-settings-rlm-model"
                value={model.value}
                placeholder="Default model"
                onInput={(e) => (model.value = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-rlm-max-iterations">Max iterations</Label>
              <Input
                id="tool-settings-rlm-max-iterations"
                type="number"
                value={String(maxIterations.value)}
                onInput={(e) =>
                  (maxIterations.value = Number((e.target as HTMLInputElement).value))
                }
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-rlm-truncate">Truncate threshold</Label>
              <Input
                id="tool-settings-rlm-truncate"
                type="number"
                value={String(truncateThreshold.value)}
                onInput={(e) =>
                  (truncateThreshold.value = Number((e.target as HTMLInputElement).value))
                }
              />
            </div>
          </div>
        )}

        {tool.toolId === 'shell_exec' && (
          <div class="space-y-3 rounded-md border border-border p-3">
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-shell-allowlist">Allowlist (one glob per line)</Label>
              <Textarea
                id="tool-settings-shell-allowlist"
                rows={3}
                value={allowlist.value}
                onInput={(e) => (allowlist.value = (e.target as HTMLTextAreaElement).value)}
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="tool-settings-shell-denylist">Denylist (one glob per line)</Label>
              <Textarea
                id="tool-settings-shell-denylist"
                rows={3}
                value={denylist.value}
                onInput={(e) => (denylist.value = (e.target as HTMLTextAreaElement).value)}
              />
            </div>
          </div>
        )}

        {saveError.value && <p class="text-xs text-destructive">{saveError.value}</p>}
      </div>

      {!isSkillGated && (
        <div class="flex justify-between gap-2 border-t border-border p-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleReset()}
            disabled={isResetting.value || isSaving.value}
          >
            {isResetting.value && <Loader2 class="size-3.5 animate-spin" />}
            Reset Defaults
          </Button>
          <Button type="submit" size="sm" disabled={isSaving.value || isResetting.value}>
            {isSaving.value && <Loader2 class="size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      )}
    </form>
  );
}
