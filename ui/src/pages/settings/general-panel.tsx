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
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { FormLayout } from '@/components/form-layout';

interface GeneralSettings {
  port: number;
  logLevel: string;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export function GeneralPanel() {
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<GeneralSettings>('general');

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
            <CardTitle>General</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <FormLayout>
              <div class="space-y-1.5">
                <Label htmlFor="general-port">Port</Label>
                <Input
                  id="general-port"
                  value={String(form.value.port)}
                  readOnly
                  aria-readonly="true"
                  class="cursor-not-allowed opacity-60"
                />
                <p class="text-xs text-muted-foreground">
                  Changing the port requires an environment-level change and server restart.
                </p>
              </div>

              <div class="space-y-1.5">
                <Label htmlFor="general-logLevel">Log level</Label>
                <Select value={form.value.logLevel} onValueChange={(v) => setField('logLevel', v)}>
                  <SelectTrigger id="general-logLevel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((lvl) => (
                      <SelectItem key={lvl} value={lvl}>
                        {lvl}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrors.value['logLevel']} />
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
