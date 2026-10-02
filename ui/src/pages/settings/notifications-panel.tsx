import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTitle } from '@/hooks/use-title';
import { showToast } from '@/lib/toast';
import { RevealKeyDialog } from './reveal-key-dialog';
import {
  listApiKeys,
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  type ApiKey,
} from '@/services/api-keys-api';

function webhookUrl(): string {
  return `${window.location.origin}/api/v1/webhooks/tasks`;
}

export function NotificationsPanel() {
  useTitle('Settings - Notifications');

  const keys = useSignal<ApiKey[]>([]);
  const loading = useSignal(true);
  const loadError = useSignal<string | null>(null);
  const urlCopied = useSignal(false);
  const newKeyName = useSignal('');
  const revealOpen = useSignal(false);
  const revealedKey = useSignal<string | null>(null);

  async function refresh() {
    keys.value = await listApiKeys();
  }

  useEffect(() => {
    refresh()
      .catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : 'Failed to load API keys';
      })
      .finally(() => {
        loading.value = false;
      });
  }, []);

  async function handleCopyUrl() {
    await navigator.clipboard.writeText(webhookUrl());
    urlCopied.value = true;
    setTimeout(() => {
      urlCopied.value = false;
    }, 1500);
  }

  async function handleCreate() {
    const name = newKeyName.value.trim();
    if (!name) return;
    try {
      const created = await createApiKey(name);
      newKeyName.value = '';
      revealedKey.value = created.key;
      revealOpen.value = true;
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to create API key');
    }
  }

  async function handleRotate(key: ApiKey) {
    if (!confirm(`Rotate "${key.name}"? The old key will stop working immediately.`)) return;
    try {
      const rotated = await rotateApiKey(key.id);
      revealedKey.value = rotated.key;
      revealOpen.value = true;
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to rotate API key');
    }
  }

  async function handleRevoke(key: ApiKey) {
    if (!confirm(`Revoke "${key.name}"? This cannot be undone.`)) return;
    try {
      await revokeApiKey(key.id);
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  }

  if (loadError.value) {
    return <div class="p-6 text-sm text-destructive">{loadError.value}</div>;
  }

  if (loading.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Webhooks</CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <p class="text-sm text-muted-foreground">
              Send a POST request here, with an API key below as a bearer token, to create a task.
            </p>
            <div class="flex items-center gap-2">
              <Input
                readOnly
                data-testid="webhook-url"
                value={webhookUrl()}
                class="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="xs"
                data-testid="webhook-copy-button"
                onClick={() => void handleCopyUrl()}
              >
                {urlCopied.value ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="flex flex-row items-center justify-between">
            <CardTitle>API Keys</CardTitle>
            <div class="flex items-center gap-2">
              <Input
                placeholder="Key name"
                value={newKeyName.value}
                onInput={(e) => (newKeyName.value = (e.target as HTMLInputElement).value)}
                class="h-8 w-40 text-xs"
              />
              <Button type="button" variant="outline" size="sm" onClick={() => void handleCreate()}>
                New key
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {keys.value.length === 0 ? (
              <p class="py-4 text-center text-sm text-muted-foreground">No API keys yet.</p>
            ) : (
              <ul class="divide-y divide-border">
                {keys.value.map((key) => (
                  <li
                    key={key.id}
                    data-slot="api-key-row"
                    class="flex items-center justify-between gap-3 py-3"
                  >
                    <div class="flex min-w-0 flex-col">
                      <span data-slot="api-key-row-name" class="text-sm font-medium">
                        {key.name}
                      </span>
                      <span class="text-xs text-muted-foreground">
                        Created {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div class="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRotate(key)}
                      >
                        Rotate
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="text-destructive hover:text-destructive"
                        onClick={() => void handleRevoke(key)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <RevealKeyDialog open={revealOpen} apiKey={revealedKey} />
    </div>
  );
}
