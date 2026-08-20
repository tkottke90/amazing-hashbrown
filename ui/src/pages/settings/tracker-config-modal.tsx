import { useSignal } from '@preact/signals';
import { CheckCircle2, Loader2, XCircle, AlertTriangle } from 'lucide-preact';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { verifyGithubToken, type AuthField, type Tracker } from '@/services/trackers-api';
import type { JSX } from 'preact';

type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; canCreate: boolean }
  | { status: 'error'; error: string };

interface TrackerConfigModalProps {
  tracker: Tracker;
  initial?: Record<string, string | undefined>;
  onSave: (values: Record<string, string | undefined>) => void;
  trigger: JSX.Element;
}

export function TrackerConfigModal({ tracker, initial, onSave, trigger }: TrackerConfigModalProps) {
  return (
    <Modal title={`Configure ${tracker.displayName}`} className="mx-auto my-16 max-w-lg p-4" trigger={trigger}>
      <TrackerConfigForm tracker={tracker} initial={initial} onSave={onSave} />
    </Modal>
  );
}

function TrackerConfigForm({
  tracker,
  initial,
  onSave,
}: Omit<TrackerConfigModalProps, 'trigger'>) {
  const { close } = useDialog();
  const values = useSignal<Record<string, string>>(
    Object.fromEntries(tracker.authSchema.map((f) => [f.key, initial?.[f.key] ?? ''])),
  );
  const testState = useSignal<TestState>({ status: 'idle' });

  async function runVerify() {
    testState.value = { status: 'loading' };
    try {
      const result = await verifyGithubToken(values.value['token'] ?? '');
      if (!result.valid) {
        testState.value = { status: 'error', error: result.error ?? 'Token could not be verified.' };
      } else {
        testState.value = { status: 'success', canCreate: result.canCreate };
      }
    } catch (err) {
      testState.value = { status: 'error', error: err instanceof Error ? err.message : 'Verify failed.' };
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    onSave(values.value);
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      {tracker.authSchema.map((field: AuthField) => (
        <div key={field.key} class="space-y-1.5">
          <Label htmlFor={`tracker-${tracker.type}-${field.key}`}>{field.label}</Label>
          <Input
            id={`tracker-${tracker.type}-${field.key}`}
            type={field.type === 'password' ? 'password' : 'text'}
            value={values.value[field.key] ?? ''}
            onInput={(e) => {
              values.value = {
                ...values.value,
                [field.key]: (e.target as HTMLInputElement).value,
              };
              testState.value = { status: 'idle' };
            }}
            placeholder={field.type === 'password' ? 'Leave blank to keep unchanged' : ''}
            required={field.required}
          />
        </div>
      ))}

      {tracker.type === 'github' && (
        <div class="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => void runVerify()}
            disabled={testState.value.status === 'loading'}
          >
            {testState.value.status === 'loading' ? (
              <>
                <Loader2 class="mr-2 size-4 animate-spin" />
                Verifying…
              </>
            ) : (
              'Verify'
            )}
          </Button>

          {testState.value.status === 'success' && testState.value.canCreate && (
            <span class="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 class="size-4 shrink-0" />
              Connected — read &amp; write (create issues enabled)
            </span>
          )}
          {testState.value.status === 'success' && !testState.value.canCreate && (
            <span class="flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle class="size-4 shrink-0" />
              Connected — read-only (token needs <code>repo</code> scope to create issues)
            </span>
          )}
          {testState.value.status === 'error' && (
            <span class="flex items-center gap-1.5 text-sm text-destructive">
              <XCircle class="size-4 shrink-0" />
              {testState.value.error}
            </span>
          )}
        </div>
      )}

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
    </form>
  );
}
