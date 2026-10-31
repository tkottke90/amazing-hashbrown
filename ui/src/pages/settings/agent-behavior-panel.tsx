import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTitle } from '@/hooks/use-title';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { FormLayout } from '@/components/form-layout';
import { SubAgentRolesCard } from './sub-agent-roles-card';

interface AgentBehaviorSettings {
  afterAgent: { enabled: boolean };
  chat: { showErrorMessages: boolean; codeBlockWrap: boolean; sidebarRetentionDays: number };
  taskBoard: { doneRetentionDays: number };
  observability: { enabled: boolean; spanOutputPreviewChars: number };
}

export function AgentBehaviorPanel() {
  useTitle('Settings - Agent behavior');
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
            <FormLayout>
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
            </FormLayout>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversation history</CardTitle>
          </CardHeader>
          <CardContent>
            <FormLayout>
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

              <div class="flex items-center justify-between">
                <div>
                  <Label htmlFor="chat-codeBlockWrap">Wrap long lines in code blocks</Label>
                  <p class="text-xs text-muted-foreground">
                    Long lines wrap to fit instead of scrolling horizontally.
                  </p>
                </div>
                <Switch
                  id="chat-codeBlockWrap"
                  checked={form.value.chat?.codeBlockWrap ?? false}
                  onCheckedChange={(v) => setField('chat.codeBlockWrap', v)}
                />
              </div>

              <div class="space-y-1.5">
                <Label htmlFor="chat-sidebarRetentionDays">
                  Hide inactive threads from sidebar after (days)
                </Label>
                <p class="text-xs text-muted-foreground">
                  0 disables this — threads never leave the sidebar due to inactivity. Hidden
                  threads aren't deleted — they stay available on the Threads page, and continuing
                  one brings it back to the sidebar.
                </p>
                <Input
                  id="chat-sidebarRetentionDays"
                  type="number"
                  min={0}
                  value={String(form.value.chat?.sidebarRetentionDays ?? 7)}
                  onInput={(e) =>
                    setField(
                      'chat.sidebarRetentionDays',
                      Number((e.target as HTMLInputElement).value),
                    )
                  }
                />
              </div>
              <FieldError errors={fieldErrors.value['chat']} />
            </FormLayout>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Task board</CardTitle>
          </CardHeader>
          <CardContent>
            <FormLayout>
              <div class="space-y-1.5">
                <Label htmlFor="taskBoard-doneRetentionDays">
                  Hide Done tasks from the board and Inbox after (days)
                </Label>
                <p class="text-xs text-muted-foreground">
                  0 disables this — Done tasks never leave the board or Inbox due to inactivity.
                  Hidden tasks aren't deleted — they stay available via the Show Archived toggle,
                  and touching one again brings it back.
                </p>
                <Input
                  id="taskBoard-doneRetentionDays"
                  type="number"
                  min={0}
                  value={String(form.value.taskBoard?.doneRetentionDays ?? 5)}
                  onInput={(e) =>
                    setField(
                      'taskBoard.doneRetentionDays',
                      Number((e.target as HTMLInputElement).value),
                    )
                  }
                />
              </div>
              <FieldError errors={fieldErrors.value['taskBoard']} />
            </FormLayout>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Observability</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <FormLayout>
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
            </FormLayout>
          </CardContent>
        </Card>

        <SubAgentRolesCard />
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
