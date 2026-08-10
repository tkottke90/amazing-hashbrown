import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';

interface AgentBehaviorSettings {
  afterAgent: { enabled: boolean };
  chat: { showErrorMessages: boolean };
  observability: { enabled: boolean; spanOutputPreviewChars: number };
}

export function AgentBehaviorPanel() {
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<AgentBehaviorSettings>('agent-behavior');

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const observabilityEnabled = form.value.observability?.enabled ?? true;

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Background processing</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex items-center justify-between">
              <div>
                <Label htmlFor="afterAgent-enabled">Enable after-agent pipeline</Label>
                <p class="text-xs text-muted-foreground">
                  Run background enrichment after each agent response.
                </p>
              </div>
              <Switch
                id="afterAgent-enabled"
                checked={form.value.afterAgent?.enabled ?? true}
                onCheckedChange={(v) => setField('afterAgent.enabled', v)}
              />
            </div>
            <FieldError errors={fieldErrors.value['afterAgent']} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversation history</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="flex items-center justify-between">
              <div>
                <Label htmlFor="chat-showErrorMessages">Show error messages</Label>
                <p class="text-xs text-muted-foreground">
                  Display raw error messages in the chat interface.
                </p>
              </div>
              <Switch
                id="chat-showErrorMessages"
                checked={form.value.chat?.showErrorMessages ?? false}
                onCheckedChange={(v) => setField('chat.showErrorMessages', v)}
              />
            </div>
            <FieldError errors={fieldErrors.value['chat']} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Observability</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <Label htmlFor="observability-enabled">Enable tracing</Label>
                <p class="text-xs text-muted-foreground">
                  Collect OpenTelemetry spans for agent runs.
                </p>
              </div>
              <Switch
                id="observability-enabled"
                checked={observabilityEnabled}
                onCheckedChange={(v) => setField('observability.enabled', v)}
              />
            </div>

            {observabilityEnabled && (
              <div class="space-y-1.5">
                <Label htmlFor="observability-spanOutputPreviewChars">
                  Span output preview characters
                </Label>
                <Input
                  id="observability-spanOutputPreviewChars"
                  type="number"
                  value={String(form.value.observability?.spanOutputPreviewChars ?? 500)}
                  onInput={(e) =>
                    setField(
                      'observability.spanOutputPreviewChars',
                      Number((e.target as HTMLInputElement).value),
                    )
                  }
                />
                <FieldError errors={fieldErrors.value['observability']} />
              </div>
            )}
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
