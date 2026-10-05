import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CredentialValueField } from '@/components/credential-value-field';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';

type GitCredentialsSettings = { github: { token?: string } };

// Authenticates workspace/project git clone/fetch/sync/push over HTTPS —
// a separate stored value from the Trackers tab's GitHub token (one
// authenticates git itself, the other the issue-tracker API). See
// docs/superpowers/specs/2026-10-05-git-credentials-design.md.
export function GitCredentialsSection() {
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<GitCredentialsSettings>('git-credentials');

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
            <CardTitle>Git</CardTitle>
          </CardHeader>
          <CardContent>
            <p class="mb-3 text-xs text-muted-foreground">
              A GitHub personal access token used to authenticate workspace and project git
              operations (clone, fetch, sync, push) over HTTPS. Separate from the Trackers tab's
              token, which is only used for the issue-tracker API.
            </p>
            <CredentialValueField
              id="git-credentials-github-token"
              label="Personal access token"
              value={form.value.github?.token}
              onChange={(next) => setField('github.token', next)}
              suggestedEnvName="GH_TOKEN"
              placeholder="Leave blank to keep the saved value"
            />
            <FieldError errors={fieldErrors.value['github.token']} />
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
