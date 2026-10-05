import { useSignal } from '@preact/signals';
import { CheckCircle2, Loader2, XCircle, AlertTriangle } from 'lucide-preact';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CredentialValueField } from '@/components/credential-value-field';
import { verifyGithubToken, type AuthField, type Tracker } from '@/services/trackers-api';
import type { JSX } from 'preact';

type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; canCreate: boolean; tokenType: 'classic' | 'fine-grained' | 'unknown' }
  | { status: 'error'; error: string };

interface TrackerConfigModalProps {
  tracker: Tracker;
  initial?: Record<string, string | undefined>;
  onSave: (values: Record<string, string | undefined>) => void;
  trigger: JSX.Element;
}

export function TrackerConfigModal({ tracker, initial, onSave, trigger }: TrackerConfigModalProps) {
  return (
    <Modal
      title={`Configure ${tracker.displayName}`}
      className="mx-auto my-16 max-w-lg p-4"
      trigger={trigger}
    >
      <TrackerConfigForm tracker={tracker} initial={initial} onSave={onSave} />
    </Modal>
  );
}

// Mirrors the server's masking sentinel (api/src/routes/v1/settings.handlers.ts's
// `MASK`) — a password field seeded with this value means "a token is already
// stored"; submitting it back unchanged tells the server to keep that value.
const MASK = '****';

function isStoredField(field: AuthField, initial?: Record<string, string | undefined>): boolean {
  return field.type === 'password' && initial?.[field.key] === MASK;
}

function TrackerConfigForm({ tracker, initial, onSave }: Omit<TrackerConfigModalProps, 'trigger'>) {
  const { close } = useDialog();
  // Password fields always start blank — the server never sends the real
  // secret back, only the "****" sentinel, so showing that as literal
  // editable text is misleading. `removed` tracks an explicit "clear this
  // field" action separately from "left blank because unchanged".
  const values = useSignal<Record<string, string>>(
    Object.fromEntries(
      tracker.authSchema.map((f) => [
        f.key,
        isStoredField(f, initial) ? '' : (initial?.[f.key] ?? ''),
      ]),
    ),
  );
  const removed = useSignal<Record<string, boolean>>({});
  const testState = useSignal<TestState>({ status: 'idle' });

  function updateFieldValue(key: string, next: string) {
    values.value = { ...values.value, [key]: next };
    if (removed.value[key]) {
      removed.value = { ...removed.value, [key]: false };
    }
    testState.value = { status: 'idle' };
  }

  async function runVerify() {
    testState.value = { status: 'loading' };
    try {
      const result = await verifyGithubToken(values.value['token'] ?? '');
      if (!result.valid) {
        testState.value = {
          status: 'error',
          error: result.error ?? 'Token could not be verified.',
        };
      } else {
        testState.value = {
          status: 'success',
          canCreate: result.canCreate,
          tokenType: result.tokenType,
        };
      }
    } catch (err) {
      testState.value = {
        status: 'error',
        error: err instanceof Error ? err.message : 'Verify failed.',
      };
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    const outgoing: Record<string, string> = {};
    for (const field of tracker.authSchema) {
      const typed = values.value[field.key] ?? '';
      if (!isStoredField(field, initial)) {
        outgoing[field.key] = typed;
      } else if (removed.value[field.key]) {
        outgoing[field.key] = '';
      } else if (typed) {
        outgoing[field.key] = typed;
      } else {
        outgoing[field.key] = MASK;
      }
    }
    onSave(outgoing);
    close();
  }

  const tokenIsBlank = !values.value['token'];
  const canVerify = tracker.authSchema.some((f) => f.key === 'token') && !tokenIsBlank;

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      {tracker.authSchema.map((field: AuthField) => {
        const stored = isStoredField(field, initial);
        const isRemoved = removed.value[field.key] === true;
        return (
          <div key={field.key} class="space-y-1.5">
            {/* CredentialValueField renders its own label + toggle row, so
                the stored-status indicator here would otherwise double up
                with it — folded into that field's helperText instead. */}
            {!field.supportsEnvRef && (
              <div class="flex items-center justify-between">
                <Label htmlFor={`tracker-${tracker.type}-${field.key}`}>{field.label}</Label>
                {stored &&
                  (isRemoved ? (
                    <span class="text-xs text-destructive">Will be removed on save</span>
                  ) : (
                    <span class="text-xs text-muted-foreground">Currently set</span>
                  ))}
              </div>
            )}
            <div class="flex gap-2 items-start">
              {field.supportsEnvRef ? (
                <div class="flex-1">
                  <CredentialValueField
                    id={`tracker-${tracker.type}-${field.key}`}
                    label={field.label}
                    value={values.value[field.key] ?? ''}
                    onChange={(next) => updateFieldValue(field.key, next)}
                    disabled={isRemoved}
                    suggestedEnvName="GH_TOKEN"
                    placeholder={stored ? 'Leave blank to keep the saved value' : undefined}
                    helperText={
                      stored ? (isRemoved ? 'Will be removed on save' : 'Currently set') : undefined
                    }
                  />
                </div>
              ) : (
                <Input
                  id={`tracker-${tracker.type}-${field.key}`}
                  type={field.type === 'password' ? 'password' : 'text'}
                  value={values.value[field.key] ?? ''}
                  disabled={isRemoved}
                  onInput={(e) => updateFieldValue(field.key, (e.target as HTMLInputElement).value)}
                  placeholder={stored ? 'Leave blank to keep the saved value' : ''}
                  required={field.required && !stored}
                  class="flex-1"
                />
              )}
              {stored && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    removed.value = { ...removed.value, [field.key]: !isRemoved };
                    values.value = { ...values.value, [field.key]: '' };
                    testState.value = { status: 'idle' };
                  }}
                >
                  {isRemoved ? 'Undo' : 'Remove'}
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {tracker.type === 'github' && (
        <div class="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => void runVerify()}
            disabled={testState.value.status === 'loading' || !canVerify}
            title={!canVerify ? 'Enter a token above to verify it' : undefined}
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

          {testState.value.status === 'success' && testState.value.tokenType === 'fine-grained' && (
            <span class="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 class="size-4 shrink-0" />
              Connected — fine-grained token (grant <code>Issues: Read and write</code> on each
              repository you want to create issues in)
            </span>
          )}
          {testState.value.status === 'success' &&
            testState.value.tokenType !== 'fine-grained' &&
            testState.value.canCreate && (
              <span class="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 class="size-4 shrink-0" />
                Connected — read &amp; write (create issues enabled)
              </span>
            )}
          {testState.value.status === 'success' &&
            testState.value.tokenType !== 'fine-grained' &&
            !testState.value.canCreate && (
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
