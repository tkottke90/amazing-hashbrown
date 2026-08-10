import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { fetchSettingsSection } from '@/services/settings-api';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { FormLayout } from '@/components/form-layout';

interface ShellConfig {
  workingDirectory?: string;
  allowlist?: string[];
  denylist?: string[];
}

interface ToolsSettings {
  webFetch: { timeoutMs: number; respectRobotsTxt: boolean };
  rlm: { maxIterations: number; truncateThreshold: number; provider?: string; model?: string };
  tools?: { shell?: ShellConfig };
}

interface ProvidersData {
  providers: { name: string }[];
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

export function ToolsPanel() {
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<ToolsSettings>('tools');

  const providerNames = useSignal<string[]>([]);

  useEffect(() => {
    fetchSettingsSection<ProvidersData>('model-providers')
      .then((d) => {
        providerNames.value = d.providers.map((p) => p.name);
      })
      .catch(() => {});
  }, []);

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Web fetch</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <FormLayout>
              <div class="space-y-1.5">
                <Label htmlFor="webFetch-timeoutMs">Timeout (ms)</Label>
                <Input
                  id="webFetch-timeoutMs"
                  type="number"
                  value={String(form.value.webFetch?.timeoutMs ?? 10000)}
                  onInput={(e) =>
                    setField('webFetch.timeoutMs', Number((e.target as HTMLInputElement).value))
                  }
                />
                <FieldError errors={fieldErrors.value['webFetch']} />
              </div>
              <div class="flex items-center gap-2">
                <input
                  id="webFetch-respectRobotsTxt"
                  type="checkbox"
                  checked={form.value.webFetch?.respectRobotsTxt ?? true}
                  onChange={(e) =>
                    setField('webFetch.respectRobotsTxt', (e.target as HTMLInputElement).checked)
                  }
                />
                <Label htmlFor="webFetch-respectRobotsTxt">Respect robots.txt</Label>
              </div>
            </FormLayout>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Retrieval loop model</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <FormLayout>
              <div class="space-y-1.5">
                <Label htmlFor="rlm-provider">Provider</Label>
                <Select
                  value={form.value.rlm?.provider ?? ''}
                  onValueChange={(v) => setField('rlm.provider', v || undefined)}
                >
                  <SelectTrigger id="rlm-provider">
                    <SelectValue placeholder="Default provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Default provider</SelectItem>
                    {providerNames.value.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrors.value['rlm']} />
              </div>
              <div class="space-y-1.5">
                <Label htmlFor="rlm-model">Model</Label>
                <Input
                  id="rlm-model"
                  value={form.value.rlm?.model ?? ''}
                  onInput={(e) =>
                    setField('rlm.model', (e.target as HTMLInputElement).value || undefined)
                  }
                  placeholder="Default model"
                />
              </div>
              <div class="space-y-1.5">
                <Label htmlFor="rlm-maxIterations">Max iterations</Label>
                <Input
                  id="rlm-maxIterations"
                  type="number"
                  value={String(form.value.rlm?.maxIterations ?? 10)}
                  onInput={(e) =>
                    setField('rlm.maxIterations', Number((e.target as HTMLInputElement).value))
                  }
                />
              </div>
              <div class="space-y-1.5">
                <Label htmlFor="rlm-truncateThreshold">Truncate threshold</Label>
                <Input
                  id="rlm-truncateThreshold"
                  type="number"
                  value={String(form.value.rlm?.truncateThreshold ?? 6000)}
                  onInput={(e) =>
                    setField('rlm.truncateThreshold', Number((e.target as HTMLInputElement).value))
                  }
                />
              </div>
            </FormLayout>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Shell execution</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <FormLayout>
              <div class="space-y-1.5">
                <Label htmlFor="tools-shell-allowlist">Allowlist (one glob per line)</Label>
                <Textarea
                  id="tools-shell-allowlist"
                  rows={4}
                  value={arrayToLines(form.value.tools?.shell?.allowlist)}
                  onInput={(e) =>
                    setField(
                      'tools.shell.allowlist',
                      linesToArray((e.target as HTMLTextAreaElement).value),
                    )
                  }
                />
              </div>
              <div class="space-y-1.5">
                <Label htmlFor="tools-shell-denylist">Denylist (one glob per line)</Label>
                <Textarea
                  id="tools-shell-denylist"
                  rows={4}
                  value={arrayToLines(form.value.tools?.shell?.denylist)}
                  onInput={(e) =>
                    setField(
                      'tools.shell.denylist',
                      linesToArray((e.target as HTMLTextAreaElement).value),
                    )
                  }
                />
              </div>
            </FormLayout>
          </CardContent>
        </Card>
      </div>

      <SaveDiscardBar
        isDirty={isDirty.value}
        isSaving={isSaving.value}
        onSave={save}
        onDiscard={discard}
      />
    </div>
  );
}
