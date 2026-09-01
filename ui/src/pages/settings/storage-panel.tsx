import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTitle } from '@/hooks/use-title';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { FormLayout } from '@/components/form-layout';

interface StorageSettings {
  wikiRoot: string;
  mcpConfigDir: string;
  artifactRoot: string;
  skillsRoot: string;
  database: { path: string };
}

const FIELDS: { id: string; label: string; key: string; description: string }[] = [
  {
    id: 'storage-wikiRoot',
    label: 'Wiki root',
    key: 'wikiRoot',
    description: 'Directory for wiki knowledge base files.',
  },
  {
    id: 'storage-mcpConfigDir',
    label: 'MCP config directory',
    key: 'mcpConfigDir',
    description: 'Directory for MCP server configuration files.',
  },
  {
    id: 'storage-artifactRoot',
    label: 'Artifact root',
    key: 'artifactRoot',
    description: 'Directory where uploaded artifacts are stored.',
  },
  {
    id: 'storage-skillsRoot',
    label: 'Skills root',
    key: 'skillsRoot',
    description: 'Directory for skill definition files.',
  },
];

export function StoragePanel() {
  useTitle('Settings - Storage');
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<StorageSettings>('storage');

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
            <CardTitle>Storage paths</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <FormLayout>
              {FIELDS.map(({ id, label, key, description }) => (
                <div key={key} class="space-y-1.5">
                  <Label htmlFor={id}>{label}</Label>
                  <Input
                    id={id}
                    value={
                      ((form.value as unknown as Record<string, unknown>)[key] as string) ?? ''
                    }
                    onInput={(e) => setField(key, (e.target as HTMLInputElement).value)}
                  />
                  <p class="text-xs text-muted-foreground">{description}</p>
                  <FieldError errors={fieldErrors.value[key]} />
                </div>
              ))}

              <div class="space-y-1.5">
                <Label htmlFor="storage-database-path">Database path</Label>
                <Input
                  id="storage-database-path"
                  value={form.value.database?.path ?? ''}
                  onInput={(e) => setField('database.path', (e.target as HTMLInputElement).value)}
                />
                <p class="text-xs text-muted-foreground">Path to the SQLite database file.</p>
                <FieldError errors={fieldErrors.value['database']} />
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
