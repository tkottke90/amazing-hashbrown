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
  fetchShellEnvVarNames,
  type ToolSettingItem,
  type ToolSettingPatch,
} from '@/services/tool-settings-api';
import { RequestError } from '@/utils/fetch.utils';
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

// Same pattern the API side validates with — config-manager only interpolates
// uppercase ${VAR} lookups, so a lowercase name would stay a literal string.
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// "${GH_TOKEN}" pasted into the name field means the name GH_TOKEN.
function normalizeEnvName(raw: string): string {
  const trimmed = raw.trim();
  return /^\$\{(.+)\}$/.exec(trimmed)?.[1] ?? trimmed;
}

function lookupFor(name: string): string {
  return name ? '${' + name + '}' : '';
}

// API fieldErrors are keyed "env.<NAME>"; keep only the env rows, by name.
function envErrorsByName(fieldErrors: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([key]) => key.startsWith('env.'))
      .map(([key, messages]) => [key.slice('env.'.length), messages.join(' ')]),
  );
}

interface EnvEntry {
  name: string;
  value: string;
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
  const envEntries = useSignal<EnvEntry[]>([]);
  const envNameQuery = useSignal('');
  const newEnvValue = useSignal('');
  // Until the user types a value, it follows the name as a ${NAME} lookup.
  const newEnvValueTouched = useSignal(false);
  const envWarn = useSignal<string | null>(null);
  const envErrors = useSignal<Record<string, string>>({});

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
    envEntries.value = Object.entries(tool.env ?? {}).map(([name, value]) => ({ name, value }));
    envNameQuery.value = '';
    newEnvValue.value = '';
    newEnvValueTouched.value = false;
    envWarn.value = null;
    envErrors.value = {};
    saveError.value = null;
    if (tool.toolId === 'shell_exec') {
      fetchShellEnvVarNames()
        .then((names) => (envVarNames.value = names))
        .catch(() => (envVarNames.value = [])); // degrade to free-text-only
    }
  }, [openedAt]);

  // Fetched once per drawer open; on failure the combobox degrades to
  // free-text-only (still fully usable, just without suggestions).
  const envVarNames = useSignal<string[]>([]);

  function setNewEnvName(raw: string) {
    envNameQuery.value = raw;
    envWarn.value = null;
    if (!newEnvValueTouched.value) newEnvValue.value = lookupFor(normalizeEnvName(raw));
  }

  function addEnvEntry() {
    const name = normalizeEnvName(envNameQuery.value);
    if (!name || envEntries.value.some((e) => e.name === name)) return;
    const value = newEnvValueTouched.value ? newEnvValue.value : lookupFor(name);
    envEntries.value = [...envEntries.value, { name, value }];
    envNameQuery.value = '';
    newEnvValue.value = '';
    newEnvValueTouched.value = false;
    envWarn.value = ENV_VAR_NAME_RE.test(name)
      ? null
      : 'config-manager only supports uppercase names — save will be rejected';
  }

  function clearEnvError(name: string) {
    if (!(name in envErrors.value)) return;
    const rest = { ...envErrors.value };
    delete rest[name];
    envErrors.value = rest;
  }

  function updateEnvValue(index: number, value: string) {
    const entry = envEntries.value[index];
    if (!entry) return;
    envEntries.value = envEntries.value.map((e, j) => (j === index ? { ...e, value } : e));
    clearEnvError(entry.name);
  }

  function removeEnvEntry(index: number) {
    const entry = envEntries.value[index];
    envEntries.value = envEntries.value.filter((_, j) => j !== index);
    if (entry) clearEnvError(entry.name);
  }

  function onEnvAddKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addEnvEntry();
    }
  }

  async function handleSave(e: Event) {
    e.preventDefault();
    isSaving.value = true;
    saveError.value = null;
    envErrors.value = {};
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
        // Always sent: the drawer was loaded from what config.yaml holds, so
        // an empty editor means "no env" and {} is how the last row is removed.
        patch.env = Object.fromEntries(envEntries.value.map((e) => [e.name, e.value]));
      }
      const updated = await patchToolSetting(tool.toolId, patch);
      onSaved(updated);
      showToast('success', `${tool.name} updated`);
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save';
      if (err instanceof RequestError && err.fieldErrors) {
        envErrors.value = envErrorsByName(err.fieldErrors);
      }
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

            {/* Environment variables — values are shown exactly as stored in
                config.yaml (lookups unresolved); the API never returns a
                resolved value (issue #220). */}
            <div class="space-y-2">
              <Label>Environment variables</Label>
              <p class="text-xs text-muted-foreground">
                PATH, HOME and USER are always set. Add a row with the same name to override one.
                Use {'${VAR}'} to read a value from the API&apos;s environment, or type a literal.
                Literals are saved to config.yaml as plain text.
              </p>
              {envEntries.value.map((entry, i) => {
                const error = envErrors.value[entry.name];
                const errorId = `tool-settings-shell-env-error-${i}`;
                return (
                  <div key={entry.name} class="space-y-1">
                    <div class="flex items-center gap-2">
                      <span class="w-40 shrink-0 truncate text-sm" title={entry.name}>
                        {entry.name}
                      </span>
                      <Input
                        className="min-w-0 flex-1 font-mono text-xs"
                        aria-label={`Value for ${entry.name}`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        value={entry.value}
                        onInput={(e) => updateEnvValue(i, (e.target as HTMLInputElement).value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove environment variable ${entry.name}`}
                        onClick={() => removeEnvEntry(i)}
                      >
                        Remove
                      </Button>
                    </div>
                    {error && (
                      <p id={errorId} class="text-xs text-destructive">
                        {error}
                      </p>
                    )}
                  </div>
                );
              })}
              <div class="space-y-1">
                <div class="flex items-end gap-2">
                  <div class="w-40 shrink-0 space-y-1">
                    <Label htmlFor="tool-settings-shell-env-name">Add variable name</Label>
                    <Input
                      id="tool-settings-shell-env-name"
                      value={envNameQuery.value}
                      placeholder="e.g. GH_TOKEN"
                      list="tool-settings-shell-env-names"
                      onInput={(e) => setNewEnvName((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => onEnvAddKeyDown(e as KeyboardEvent)}
                    />
                  </div>
                  <Input
                    className="min-w-0 flex-1 font-mono text-xs"
                    aria-label="Value for new variable"
                    placeholder="${VAR} or a literal"
                    value={newEnvValue.value}
                    onInput={(e) => {
                      newEnvValue.value = (e.target as HTMLInputElement).value;
                      newEnvValueTouched.value = true;
                    }}
                    onKeyDown={(e) => onEnvAddKeyDown(e as KeyboardEvent)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!normalizeEnvName(envNameQuery.value)}
                    onClick={addEnvEntry}
                  >
                    Add
                  </Button>
                </div>
                <datalist id="tool-settings-shell-env-names">
                  {envVarNames.value
                    .filter(
                      (n) =>
                        n.toLowerCase().includes(envNameQuery.value.toLowerCase()) &&
                        !envEntries.value.some((e) => e.name === n),
                    )
                    .map((n) => (
                      <option key={n} value={n} />
                    ))}
                </datalist>
                {envWarn.value && <p class="text-xs text-destructive">{envWarn.value}</p>}
              </div>
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
